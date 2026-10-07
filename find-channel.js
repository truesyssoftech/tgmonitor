require("dotenv").config();

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const session = new StringSession(process.env.TELEGRAM_SESSION);

const client = new TelegramClient(
    session,
    apiId,
    apiHash,
    {
        connectionRetries: 5
    }
);

(async () => {

    await client.connect();

    const channel = await client.getEntity("ipo_Alarm");

    console.log("CHANNEL FOUND");
    console.log("ID:", channel.id?.toString());
    console.log("Username:", channel.username);
    console.log("Title:", channel.title);
    console.log("Broadcast:", channel.broadcast);

    await client.disconnect();

})();