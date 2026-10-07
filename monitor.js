require("dotenv").config();

const http = require("http");
const axios = require("axios");

const {
    TelegramClient
} = require("telegram");

const {
    StringSession
} = require("telegram/sessions");

const {
    NewMessage
} = require("telegram/events");


// ============================================================
// CONFIGURATION
// ============================================================

const API_ID = Number(process.env.TELEGRAM_API_ID);

const API_HASH =
    process.env.TELEGRAM_API_HASH;

const TELEGRAM_SESSION =
    process.env.TELEGRAM_SESSION;

const TELEGRAM_CHANNEL =
    process.env.TELEGRAM_CHANNEL || "ipo_Alarm";

const WEBHOOK_URL =
    process.env.WEBHOOK_URL;

const WEBHOOK_SECRET =
    process.env.WEBHOOK_SECRET || "";

const PORT =
    Number(process.env.PORT) || 3000;

const HEARTBEAT_INTERVAL_MS =
    Number(
        process.env.HEARTBEAT_INTERVAL_MS
    ) || 60000;

const WEBHOOK_TIMEOUT_MS =
    Number(
        process.env.WEBHOOK_TIMEOUT_MS
    ) || 15000;

const WEBHOOK_RETRIES =
    Number(
        process.env.WEBHOOK_RETRIES
    ) || 3;


// ============================================================
// RUNTIME STATE
// ============================================================

let channelEntity = null;

let channelId = null;

let heartbeatTimer = null;

let shuttingDown = false;

let reconnecting = false;

let telegramConnected = false;

let lastMessageId = null;

let lastMessageAt = null;

let healthServer = null;


// ============================================================
// DUPLICATE MESSAGE PROTECTION
// ============================================================

const processedMessages = new Map();

const PROCESSED_MESSAGE_TTL =
    30 * 60 * 1000;


// ============================================================
// TELEGRAM CLIENT
// ============================================================

const session =
    new StringSession(
        TELEGRAM_SESSION || ""
    );

const client =
    new TelegramClient(
        session,
        API_ID,
        API_HASH,
        {
            connectionRetries: 10,
            autoReconnect: true
        }
    );


// ============================================================
// LOGGING
// ============================================================

function log(message) {

    console.log(
        `[${new Date().toISOString()}] ${message}`
    );
}


function logError(message, error = "") {

    console.error(
        `[${new Date().toISOString()}] ${message}`,
        error
    );
}


// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================

function validateEnvironment() {

    const required = [
        "TELEGRAM_API_ID",
        "TELEGRAM_API_HASH",
        "TELEGRAM_SESSION",
        "WEBHOOK_URL"
    ];

    const missing =
        required.filter(
            key => !process.env[key]
        );

    if (missing.length > 0) {

        logError(
            `[FATAL] Missing environment variables: ${missing.join(", ")}`
        );

        process.exit(1);
    }


    if (
        !Number.isInteger(API_ID) ||
        API_ID <= 0
    ) {

        logError(
            "[FATAL] TELEGRAM_API_ID is invalid."
        );

        process.exit(1);
    }


    try {

        new URL(WEBHOOK_URL);

    } catch {

        logError(
            "[FATAL] WEBHOOK_URL is invalid."
        );

        process.exit(1);
    }
}


// ============================================================
// HEALTH SERVER
// ============================================================

function startHealthServer() {

    healthServer =
        http.createServer(
            (req, res) => {

                // --------------------------------------------
                // Health endpoint
                // --------------------------------------------

                if (
                    req.url === "/health"
                ) {

                    const response = {

                        status: "ok",

                        service:
                            "telegram-ipo-alarm-monitor",

                        telegram:
                            telegramConnected
                                ? "connected"
                                : "disconnected",

                        channel:
                            TELEGRAM_CHANNEL,

                        channelId:
                            channelId,

                        lastMessageId:
                            lastMessageId,

                        lastMessageAt:
                            lastMessageAt
                                ? lastMessageAt.toISOString()
                                : null,

                        timestamp:
                            new Date().toISOString()
                    };


                    res.writeHead(
                        200,
                        {
                            "Content-Type":
                                "application/json",

                            "Cache-Control":
                                "no-cache"
                        }
                    );


                    res.end(
                        JSON.stringify(
                            response
                        )
                    );


                    return;
                }


                // --------------------------------------------
                // Root endpoint
                // --------------------------------------------

                res.writeHead(
                    200,
                    {
                        "Content-Type":
                            "text/plain"
                    }
                );


                res.end(
                    "Telegram IPO Alarm Monitor is running."
                );
            }
        );


    healthServer.listen(
        PORT,
        "0.0.0.0",
        () => {

            log(
                `Health server listening on 0.0.0.0:${PORT}`
            );

        }
    );


    healthServer.on(
        "error",
        error => {

            logError(
                "Health server error:",
                error.message
            );

        }
    );
}


// ============================================================
// DUPLICATE PROTECTION
// ============================================================

function getMessageKey(message) {

    return `${channelId}:${message.id}`;
}


function isDuplicate(message) {

    const key =
        getMessageKey(message);


    if (
        processedMessages.has(key)
    ) {

        return true;
    }


    processedMessages.set(
        key,
        Date.now()
    );


    return false;
}


function cleanupProcessedMessages() {

    const now =
        Date.now();


    for (
        const [
            key,
            timestamp
        ] of processedMessages.entries()
    ) {

        if (
            now - timestamp >
            PROCESSED_MESSAGE_TTL
        ) {

            processedMessages.delete(
                key
            );
        }
    }
}


// ============================================================
// MEDIA INFORMATION
// ============================================================

function getMediaInfo(message) {

    if (!message.media) {

        return {
            hasMedia: false,
            type: null
        };
    }


    return {

        hasMedia: true,

        type:
            message.media.className ||
            "unknown"
    };
}


// ============================================================
// TELEGRAM MESSAGE URL
// ============================================================

function getMessageUrl(
    channel,
    messageId
) {

    if (
        !channel ||
        !channel.username
    ) {

        return null;
    }


    return (
        `https://t.me/${channel.username}/${messageId}`
    );
}


// ============================================================
// SLEEP
// ============================================================

function sleep(ms) {

    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}


// ============================================================
// WEBHOOK DELIVERY
// ============================================================

async function sendWebhook(
    payload
) {

    let lastError = null;


    for (
        let attempt = 1;
        attempt <= WEBHOOK_RETRIES;
        attempt++
    ) {

        try {

            log(
                `Webhook attempt ${attempt}/${WEBHOOK_RETRIES}`
            );


            const headers = {

                "Content-Type":
                    "application/json",

                "User-Agent":
                    "IPO-Alarm-Telegram-Monitor/1.0",

                "X-Telegram-Monitor":
                    "ipo-alarm"
            };


            if (WEBHOOK_SECRET) {

                headers[
                    "X-Webhook-Secret"
                ] = WEBHOOK_SECRET;
            }


            const response =
                await axios.post(
                    WEBHOOK_URL,
                    payload,
                    {
                        headers,

                        timeout:
                            WEBHOOK_TIMEOUT_MS,

                        validateStatus:
                            () => true
                    }
                );


            if (
                response.status >= 200 &&
                response.status < 300
            ) {

                log(
                    `Webhook delivered successfully. HTTP ${response.status}`
                );

                return true;
            }


            lastError =
                new Error(
                    `Webhook returned HTTP ${response.status}`
                );


            logError(
                lastError.message
            );

        } catch (error) {

            lastError =
                error;


            logError(
                `Webhook request failed: ${error.message}`
            );
        }


        if (
            attempt <
            WEBHOOK_RETRIES
        ) {

            const delay =
                Math.pow(
                    2,
                    attempt
                ) * 1000;


            log(
                `Retrying webhook in ${delay}ms...`
            );


            await sleep(delay);
        }
    }


    logError(
        `Webhook failed after ${WEBHOOK_RETRIES} attempts`,
        lastError?.message
    );


    return false;
}


// ============================================================
// PROCESS TELEGRAM MESSAGE
// ============================================================

async function processMessage(
    message
) {

    if (!message) {

        return;
    }


    // --------------------------------------------
    // Ignore Telegram service messages
    // --------------------------------------------

    if (message.action) {

        log(
            `Ignoring Telegram service message ${message.id}`
        );

        return;
    }


    // --------------------------------------------
    // Duplicate protection
    // --------------------------------------------

    if (
        isDuplicate(message)
    ) {

        log(
            `Duplicate message ignored: ${message.id}`
        );

        return;
    }


    // --------------------------------------------
    // Update state
    // --------------------------------------------

    lastMessageId =
        message.id;

    lastMessageAt =
        new Date();


    // --------------------------------------------
    // Extract text
    // --------------------------------------------

    const text =
        message.text ||
        message.message ||
        "";


    // --------------------------------------------
    // Media
    // --------------------------------------------

    const media =
        getMediaInfo(
            message
        );


    // --------------------------------------------
    // Message URL
    // --------------------------------------------

    const messageUrl =
        getMessageUrl(
            channelEntity,
            message.id
        );


    // --------------------------------------------
    // Webhook payload
    // --------------------------------------------

    const payload = {

        event:
            "telegram.channel_post",

        source:
            "telegram",

        receivedAt:
            new Date().toISOString(),


        channel: {

            id:
                channelId,

            title:
                channelEntity?.title ||
                null,

            username:
                channelEntity?.username ||
                null,

            type:
                channelEntity?.className ||
                null
        },


        message: {

            id:
                message.id,

            text:
                text,

            date:
                message.date
                    ? new Date(
                        message.date
                    ).toISOString()
                    : null,

            url:
                messageUrl,

            hasMedia:
                media.hasMedia,

            mediaType:
                media.type
        }
    };


    // --------------------------------------------
    // Logging
    // --------------------------------------------

    log(
        "================================================"
    );

    log(
        "NEW TELEGRAM CHANNEL POST"
    );

    log(
        `Channel: ${channelEntity?.title}`
    );

    log(
        `Username: @${channelEntity?.username || "N/A"}`
    );

    log(
        `Message ID: ${message.id}`
    );

    log(
        `Media: ${media.hasMedia ? media.type : "none"}`
    );

    log(
        `URL: ${messageUrl || "N/A"}`
    );

    log(
        `Text: ${text.substring(0, 500)}`
    );

    log(
        "================================================"
    );


    // --------------------------------------------
    // Send webhook
    // --------------------------------------------

    const success =
        await sendWebhook(
            payload
        );


    if (!success) {

        logError(
            `Webhook delivery failed for message ${message.id}`
        );
    }
}


// ============================================================
// CONNECT TELEGRAM
// ============================================================

async function connectTelegram() {

    log(
        "Connecting to Telegram..."
    );


    await client.connect();


    const authorized =
        await client.checkAuthorization();


    if (!authorized) {

        telegramConnected = false;


        throw new Error(
            "Telegram session is not authorized."
        );
    }


    telegramConnected = true;


    log(
        "Telegram authorization confirmed."
    );


    // --------------------------------------------
    // Resolve channel
    // --------------------------------------------

    channelEntity =
        await client.getEntity(
            TELEGRAM_CHANNEL
        );


    channelId =
        channelEntity.id
            ?.toString();


    log(
        "================================================"
    );

    log(
        "Telegram channel resolved"
    );

    log(
        `Title: ${channelEntity.title}`
    );

    log(
        `Username: @${channelEntity.username || "N/A"}`
    );

    log(
        `ID: ${channelId}`
    );

    log(
        `Type: ${channelEntity.className}`
    );

    log(
        "================================================"
    );
}


// ============================================================
// REGISTER TELEGRAM LISTENER
// ============================================================

function registerMessageListener() {

    client.addEventHandler(

        async event => {

            try {

                await processMessage(
                    event.message
                );

            } catch (error) {

                logError(
                    "Message processing error:",
                    error
                );
            }

        },


        new NewMessage({

            chats: [
                TELEGRAM_CHANNEL
            ]

        })
    );


    log(
        `Listening for new messages from ${TELEGRAM_CHANNEL}`
    );
}


// ============================================================
// TELEGRAM RECONNECT
// ============================================================

async function reconnectTelegram() {

    if (
        reconnecting ||
        shuttingDown
    ) {

        return;
    }


    reconnecting = true;


    try {

        log(
            "Starting Telegram reconnect..."
        );


        telegramConnected =
            false;


        try {

            await client.disconnect();

        } catch (error) {

            logError(
                "Disconnect error:",
                error.message
            );
        }


        await sleep(3000);


        await connectTelegram();


        log(
            "Telegram reconnect successful."
        );

    } catch (error) {

        telegramConnected =
            false;


        logError(
            "Telegram reconnect failed:",
            error.message
        );

    } finally {

        reconnecting =
            false;
    }
}


// ============================================================
// HEARTBEAT
// ============================================================

function startHeartbeat() {

    heartbeatTimer =
        setInterval(
            async () => {

                if (shuttingDown) {

                    return;
                }


                cleanupProcessedMessages();


                try {

                    const authorized =
                        await client.checkAuthorization();


                    telegramConnected =
                        authorized;


                    log(
                        `[HEARTBEAT] ` +
                        `Telegram=${authorized ? "CONNECTED" : "NOT_AUTHORIZED"} | ` +
                        `Channel=${TELEGRAM_CHANNEL} | ` +
                        `LastMessage=${lastMessageId ?? "none"} | ` +
                        `Processed=${processedMessages.size}`
                    );


                    if (!authorized) {

                        await reconnectTelegram();
                    }

                } catch (error) {

                    telegramConnected =
                        false;


                    logError(
                        "[HEARTBEAT] Telegram connection check failed:",
                        error.message
                    );


                    await reconnectTelegram();
                }

            },

            HEARTBEAT_INTERVAL_MS
        );


    log(
        `Heartbeat started: every ${HEARTBEAT_INTERVAL_MS / 1000}s`
    );
}


// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(
    signal
) {

    if (shuttingDown) {

        return;
    }


    shuttingDown =
        true;


    log(
        `Received ${signal}. Shutting down...`
    );


    // --------------------------------------------
    // Stop heartbeat
    // --------------------------------------------

    if (heartbeatTimer) {

        clearInterval(
            heartbeatTimer
        );

        heartbeatTimer =
            null;
    }


    // --------------------------------------------
    // Stop health server
    // --------------------------------------------

    if (healthServer) {

        try {

            healthServer.close();

        } catch (error) {

            logError(
                "Health server shutdown error:",
                error.message
            );
        }
    }


    // --------------------------------------------
    // Disconnect Telegram
    // --------------------------------------------

    try {

        telegramConnected =
            false;

        await client.disconnect();

        log(
            "Telegram disconnected."
        );

    } catch (error) {

        logError(
            "Telegram disconnect error:",
            error.message
        );
    }


    log(
        "Shutdown complete."
    );


    process.exit(0);
}


// ============================================================
// PROCESS SIGNALS
// ============================================================

process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);


process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);


// ============================================================
// ERROR HANDLING
// ============================================================

process.on(
    "unhandledRejection",
    error => {

        logError(
            "Unhandled promise rejection:",
            error
        );
    }
);


process.on(
    "uncaughtException",
    error => {

        logError(
            "Uncaught exception:",
            error
        );
    }
);


// ============================================================
// MAIN
// ============================================================

async function main() {

    // --------------------------------------------
    // Validate environment
    // --------------------------------------------

    validateEnvironment();


    // --------------------------------------------
    // Startup information
    // --------------------------------------------

    log(
        "================================================"
    );

    log(
        "Telegram IPO Alarm Monitor"
    );

    log(
        "Environment: Miles Hosting"
    );

    log(
        "Starting..."
    );

    log(
        `Channel: ${TELEGRAM_CHANNEL}`
    );

    log(
        `Webhook: ${WEBHOOK_URL}`
    );

    log(
        `Port: ${PORT}`
    );

    log(
        "================================================"
    );


    // --------------------------------------------
    // Start HTTP health server
    // --------------------------------------------

    startHealthServer();


    // --------------------------------------------
    // Connect Telegram
    // --------------------------------------------

    await connectTelegram();


    // --------------------------------------------
    // Register Telegram listener
    // --------------------------------------------

    registerMessageListener();


    // --------------------------------------------
    // Start heartbeat
    // --------------------------------------------

    startHeartbeat();


    // --------------------------------------------
    // Running
    // --------------------------------------------

    log(
        "================================================"
    );

    log(
        "TELEGRAM MONITOR IS RUNNING"
    );

    log(
        `Monitoring: @${TELEGRAM_CHANNEL}`
    );

    log(
        "Waiting for new channel posts..."
    );

    log(
        "================================================"
    );
}


// ============================================================
// START APPLICATION
// ============================================================

main()
    .catch(
        error => {

            logError(
                "FATAL STARTUP ERROR:",
                error
            );

            process.exit(1);
        }
    );
