require('dotenv').config(); // Load environment variables from .env

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient, ObjectId } = require('mongodb'); // Import MongoClient and ObjectId

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- Configuration ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID; // Ensure this is parsed as a number if needed
const WEB_SERVER_PORT = process.env.WEB_SERVER_PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_GROUP_ID || !MONGODB_URI || !MONGODB_DB_NAME) {
    console.error("ERROR: Essential environment variables (TELEGRAM_BOT_TOKEN, TELEGRAM_GROUP_ID, MONGODB_URI, MONGODB_DB_NAME) not set in .env file.");
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

let db; // To hold our MongoDB database instance

// --- MongoDB Connection ---
async function connectToMongo() {
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db(MONGODB_DB_NAME);
        console.log("Connected successfully to MongoDB server");
    } catch (err) {
        console.error("Failed to connect to MongoDB:", err);
        process.exit(1); // Exit if DB connection fails
    }
}

// --- Express Middleware ---
app.use(express.json()); // To parse JSON request bodies
app.use(express.static('public')); // Serve static files from the 'public' directory

// --- Web Server Endpoints ---

// Get all incidents
app.get('/incidents', async (req, res) => {
    try {
        const incidents = await db.collection('incidents').find({}).toArray();
        res.json(incidents);
    } catch (error) {
        console.error("Error fetching incidents:", error);
        res.status(500).send("Error fetching incidents.");
    }
});

// Delete an incident
app.delete('/incidents/:id', async (req, res) => {
    const incidentIdToDelete = req.params.id; // This is the MongoDB _id string

    try {
        // Find the incident first to get its Telegram message ID if needed for group update
        const incident = await db.collection('incidents').findOne({ _id: new ObjectId(incidentIdToDelete) });

        if (!incident) {
            return res.status(404).send({ message: 'Incident not found.' });
        }

        const result = await db.collection('incidents').deleteOne({ _id: new ObjectId(incidentIdToDelete) });

        if (result.deletedCount === 1) {
            console.log(`Incident ${incidentIdToDelete} deleted from DB.`);
            io.emit('incident_deleted', incidentIdToDelete); // Notify clients with the original _id string
            res.status(200).send({ message: 'Incident deleted successfully.' });

            // Optional: If you want to also update the Telegram message to indicate deletion
            // try {
            //     await bot.editMessageText(
            //         `Incident #${incident.telegram_message_id} has been deleted from the dashboard.`,
            //         {
            //             chat_id: incident.telegram_chat_id,
            //             message_id: incident.telegram_message_id,
            //             reply_markup: { remove_keyboard: true } // Remove buttons
            //         }
            //     );
            // } catch (telegramError) {
            //     console.warn(`Could not edit Telegram message for deleted incident ${incident.telegram_message_id}:`, telegramError.message);
            // }

        } else {
            res.status(404).send({ message: 'Incident not found or already deleted.' });
        }
    } catch (error) {
        console.error("Error deleting incident:", error);
        res.status(500).send("Error deleting incident.");
    }
});


// --- Telegram Bot Logic ---

// Listen for private messages with location
bot.on('location', async (msg) => {
    const chatId = msg.chat.id;
    const from = msg.from;
    const location = msg.location; // { latitude, longitude }

    console.log(`Received location from ${from.first_name} (${from.username || 'N/A'}) at ${location.latitude}, ${location.longitude}`);

    // Prepare buttons for the group message
    const inlineKeyboard = {
        inline_keyboard: [
            [
                { text: "Eagles 24 Tow", callback_data: `tow_eagles_${from.id}` },
                { text: "Other Tow", callback_data: `tow_other_${from.id}` }
            ],
            [{ text: "Scene Cleared", callback_data: `scene_cleared_${from.id}` }]
        ]
    };

    const messageText = `🚨 **New Incident Report!** 🚨\n\n` +
                        `Reporter: ${from.first_name} (@${from.username || 'N/A'})\n` +
                        `Location: Latitude ${location.latitude}, Longitude ${location.longitude}\n` +
                        `[View on Google Maps](http://maps.google.com/maps?q=${location.latitude},${location.longitude})\n\n` +
                        `_Please click a button below to update the status._`;

    try {
        // Forward location as a native Telegram location message to the group
        await bot.sendLocation(TELEGRAM_GROUP_ID, location.latitude, location.longitude);

        // Send a text message with buttons to the group
        const forwardedMessage = await bot.sendMessage(
            TELEGRAM_GROUP_ID,
            messageText,
            {
                reply_markup: inlineKeyboard,
                parse_mode: 'Markdown',
                disable_web_page_preview: true // Prevent Telegram from showing a large map preview for the Google Maps link
            }
        );

        // Store incident details in MongoDB
        const newIncident = {
            reporter_id: from.id,
            reporter_name: from.first_name,
            latitude: location.latitude,
            longitude: location.longitude,
            status: "active", // Initial status
            telegram_message_id: forwardedMessage.message_id,
            telegram_chat_id: forwardedMessage.chat.id,
            timestamp: new Date() // Store as BSON Date
        };
        const result = await db.collection('incidents').insertOne(newIncident);
        const insertedIncident = { ...newIncident, _id: result.insertedId }; // Add _id from MongoDB

        console.log(`Incident stored in MongoDB:`, insertedIncident);
        bot.sendMessage(chatId, "Your location has been forwarded to emergency response services.");

        // Notify all connected web clients about the new incident
        io.emit('new_incident', insertedIncident);

    } catch (error) {
        console.error("Error handling location (Telegram or DB):", error);
        bot.sendMessage(chatId, "Sorry, there was an error processing your location.");
    }
});

// Listen for button callbacks from the group
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const queryId = callbackQuery.id;

    console.log(`Callback query received: ${data} from message ${msg.message_id}`);

    const parts = data.split('_');
    const action = parts[0]; // 'tow' or 'scene'
    const type = parts[1];   // 'eagles', 'other', 'cleared'

    let newStatus = "";
    let updatedMessageText = msg.text || msg.caption; // Get original text
    let removeButtons = false;

    if (action === "tow") {
        newStatus = `Tow Requested: ${type === 'eagles' ? 'Eagles 24' : 'Other'}`;
    } else if (action === "scene" && type === "cleared") {
        newStatus = "Scene Cleared";
        removeButtons = true; // Remove buttons once cleared
    } else {
        await bot.answerCallbackQuery(queryId, { text: "Unknown action." });
        return;
    }

    updatedMessageText += `\n\n_Status: ${newStatus} (by @${callbackQuery.from.username || 'N/A'} at ${new Date().toLocaleTimeString()})_`;

    // Update the original message in the group
    try {
        await bot.editMessageText(updatedMessageText, {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            reply_markup: removeButtons ? undefined : msg.reply_markup, // Remove or keep buttons
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });

        // Update incident status in MongoDB
        const result = await db.collection('incidents').findOneAndUpdate(
            { telegram_message_id: msg.message_id, telegram_chat_id: msg.chat.id },
            { $set: { status: newStatus, last_updated: new Date() } },
            { returnDocument: 'after' } // Return the updated document
        );

        if (result.value) { // Check if document was found and updated
            console.log(`Incident ${result.value._id} status updated to: ${newStatus}`);
            io.emit('incident_updated', result.value); // Notify web clients about the status update
        } else {
            console.warn(`Incident with Telegram message ID ${msg.message_id} not found in DB for status update.`);
        }

        await bot.answerCallbackQuery(queryId, { text: `Status updated to: ${newStatus}` });
    } catch (error) {
        console.error("Error editing message or updating incident status in DB:", error);
        await bot.answerCallbackQuery(queryId, { text: "Error updating status." });
    }
});

bot.on('polling_error', (error) => {
    console.error("Polling error:", error.code, error.message);
});

// --- Socket.IO Connection ---
io.on('connection', async (socket) => {
    console.log('A user connected to the web interface');
    // Send all existing incidents to the newly connected client
    try {
        const initialIncidents = await db.collection('incidents').find({}).toArray();
        socket.emit('initial_incidents', initialIncidents);
    } catch (error) {
        console.error("Error fetching initial incidents for new socket connection:", error);
    }

    socket.on('disconnect', () => {
        console.log('User disconnected from the web interface');
    });
});

// --- Start Server ---
async function startServer() {
    await connectToMongo(); // Connect to MongoDB first
    server.listen(WEB_SERVER_PORT, () => {
        console.log(`Web server listening on port ${WEB_SERVER_PORT}`);
        console.log(`Telegram Bot started. Send your location to it privately.`);
        console.log(`Open http://localhost:${WEB_SERVER_PORT} in your browser.`);
    });
}

startServer();