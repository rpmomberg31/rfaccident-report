// telegram-incident-bot/server.js

require('dotenv').config(); // Load environment variables from .env (MUST BE AT THE VERY TOP)

// --- Module Imports ---
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors'); // For allowing cross-origin requests from your dashboard website

// --- Configuration ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID; // Must be a negative number for group chat IDs
const WEB_SERVER_PORT = process.env.WEB_SERVER_PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME;

// --- Essential Environment Variable Check ---
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_GROUP_ID || !MONGODB_URI || !MONGODB_DB_NAME) {
    console.error("ERROR: Essential environment variables (TELEGRAM_BOT_TOKEN, TELEGRAM_GROUP_ID, MONGODB_URI, MONGODB_DB_NAME) not set in .env file.");
    process.exit(1);
}

// --- Initialize Express App, HTTP Server, and Socket.IO Server ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server); // <--- 'io' is defined here, crucial for Socket.IO server functionality

// --- Initialize Telegram Bot ---
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// --- MongoDB Database Connection ---
let db; // Global variable to hold our MongoDB database instance

async function connectToMongo() {
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db(MONGODB_DB_NAME);
        console.log("Connected successfully to MongoDB server");
    } catch (err) {
        console.error("Failed to connect to MongoDB:", err);
        // Important: Exit if DB connection fails, as the app can't function without it
        process.exit(1);
    }
}

// --- Express Middleware ---
app.use(cors()); // Enable CORS for all routes (important for your separate dashboard website)
app.use(express.json()); // To parse JSON request bodies
app.use(express.static('public')); // Serve static files from the 'public' directory

// --- Web Server API Endpoints ---

// GET all incidents
app.get('/incidents', async (req, res) => {
    try {
        const incidents = await db.collection('incidents').find({}).toArray();
        res.json(incidents);
    } catch (error) {
        console.error("Error fetching incidents:", error);
        res.status(500).send("Error fetching incidents.");
    }
});

// DELETE an incident by ID
app.delete('/incidents/:id', async (req, res) => {
    const incidentIdToDelete = req.params.id; // This is the MongoDB _id string

    try {
        // We'll delete directly by _id as the web dashboard handles display/deletion
        const result = await db.collection('incidents').deleteOne({ _id: new ObjectId(incidentIdToDelete) });

        if (result.deletedCount === 1) {
            console.log(`Incident ${incidentIdToDelete} deleted from DB.`);
            // Notify all connected web clients about the deletion
            io.emit('incident_deleted', incidentIdToDelete);
            res.status(200).send({ message: 'Incident deleted successfully.' });
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

    console.log(`Received location from ${from.first_name} (${from.username || 'N/A'}) at Lat: ${location.latitude}, Lon: ${location.longitude}`);

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
                disable_web_page_preview: true
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
        await bot.sendMessage(chatId, "Your location has been forwarded to the group and updated on the web interface.");

        // Notify all connected web clients about the new incident in real-time
        io.emit('new_incident', insertedIncident);

    } catch (error) {
        console.error("Error handling location (Telegram or DB):", error);
        await bot.sendMessage(chatId, "Sorry, there was an error processing your location.");
    }
});

// Listen for button callbacks from the group messages
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const queryId = callbackQuery.id;

    console.log(`Callback query received: ${data} from message ${msg.message_id}`);

    const parts = data.split('_');
    const action = parts[0]; // 'tow' or 'scene'
    const type = parts[1];   // 'eagles', 'other', 'cleared'

    let newStatus = "";
    let updatedMessageText = msg.text || msg.caption; // Get original text (caption if it's a photo/location)
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

    // Update the original message in the group to reflect status change
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
            { returnDocument: 'after' } // Return the updated document after modification
        );

        if (result.value) { // Check if document was found and updated
            console.log(`Incident ${result.value._id} status updated to: ${newStatus}`);
            // Notify web clients about the status update in real-time
            io.emit('incident_updated', result.value);
        } else {
            console.warn(`Incident with Telegram message ID ${msg.message_id} not found in DB for status update.`);
        }

        await bot.answerCallbackQuery(queryId, { text: `Status updated to: ${newStatus}` });
    } catch (error) {
        console.error("Error editing message or updating incident status in DB:", error);
        await bot.answerCallbackQuery(queryId, { text: "Error updating status." });
    }
});

// Handle polling errors from Telegram (e.g., conflicts, network issues)
bot.on('polling_error', (error) => {
    console.error("Polling error:", error.code, error.message);
});

// --- Socket.IO Connection Handling ---
io.on('connection', async (socket) => { // <--- This block is correctly placed after 'io' is defined
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

// --- Start Server Function ---
async function startServer() {
    await connectToMongo(); // Connect to MongoDB first
    server.listen(WEB_SERVER_PORT, () => {
        console.log(`Web server listening on port ${WEB_SERVER_PORT}`);
        console.log(`Telegram Bot started. Send your location to it privately.`);
        console.log(`Open your dashboard at http://localhost:${WEB_SERVER_PORT} (for local testing) or your Render URL.`);
    });
}

// Execute the server start function
startServer();