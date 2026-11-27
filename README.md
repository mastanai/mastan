# Mastan

**Your own AI assistant that lives in your chats.** You write to it on Telegram, WhatsApp or a private web page, like you write to a person. It answers, remembers what you told it, makes files for you (presentations, spreadsheets, documents) and can do work on a schedule while you sleep.

This is the real code behind [mastan.ai](https://mastan.ai). It is free. Take it, run it, change it.

## Read this first

Mastan is **not an app for your laptop**. You cannot double-click it on Windows or on a Mac.

It runs on a small rented computer on the internet (a "server") that stays on day and night. That is why it can answer you at 3 a.m. and finish long jobs while your laptop is closed.

So there are two ways to get your own Mastan:

| | The easy way | The do-it-yourself way |
|---|---|---|
| What you do | Write to Mastan and ask for a private one | Follow the steps on this page |
| Time | A few minutes | An evening, if you are patient |
| You need to know | Nothing technical | How to copy and paste commands |
| Who fixes it when it breaks | We do | You do |

**The easy way:** open [mastan.ai](https://mastan.ai), start a chat and say "I want a private Mastan".

**The do-it-yourself way:** keep reading.

## What you need

1. **A server.** A small Linux server from any provider. About 5 euros a month is enough.
2. **An AI subscription of your own.** A Claude subscription. Mastan uses your subscription to think. Without it, Mastan has no brain. A ChatGPT subscription is optional: with it, Mastan hands coding jobs to Codex.
3. **Telegram** on your phone. This is where you will talk to your Mastan.

You pay for the server and the subscription yourself, in two different places. Mastan itself costs nothing.

Pick **Ubuntu 24.04 or newer** when you rent the server. 4 GB of memory is enough.

## Step 1: Create your Telegram bot

Do this first, on your phone. You will paste the two results in step 2.

1. In Telegram, open a chat with **@BotFather**.
2. Send `/newbot` and follow the questions. Pick any name you like.
3. BotFather gives you a long code called a **token**. Keep it. It is the key to your bot, so do not share it.
4. Open a chat with **@userinfobot**. It tells you your **ID**, a number. Keep it too. It makes sure your Mastan answers only you.

## Step 2: Install Mastan

Log in to your server. Copy this one line, paste it and press Enter:

```sh
curl -fsSL https://raw.githubusercontent.com/mastanai/mastan/main/install.sh | sudo bash
```

It takes about three minutes. It asks for the token and the ID from step 1. The token stays hidden while you paste it.

Running it again is safe. It updates Mastan and keeps your settings.

No server yet and you only want to look? Press the green **Code** button at the top of this page, then **Download ZIP**.

## Step 3: Connect your AI subscription

Paste this and press Enter:

```sh
sudo mastan-login claude
```

It shows a link. Open it on your phone or laptop, sign in with your own Claude account, and paste the code it gives you back into the server.

Have ChatGPT too? Paste this as well:

```sh
sudo mastan-login codex
```

It shows a link and a short code. Open the link, sign in with your ChatGPT account and type the code.

## Step 4: Say hello

Open your bot in Telegram and say hello.

If it stays quiet, this shows what Mastan is doing:

```sh
sudo journalctl -u mastan-me -f
```

## Honest notes

- **This guide is new.** The installer has been tested from zero on empty Ubuntu 24.04 and 26.04 servers, including a restart and a reboot. The two sign-in steps and the first Telegram chat are being tested with a real account now. If a step fails for you, [open an issue](https://github.com/mastanai/mastan/issues) and tell us where.
- **Schedules use Riyadh time for now.** "Remind me at 9" means 9:00 in Riyadh. A setting for your own time zone is planned.
- **Use your own subscription only for yourself.** A personal AI subscription is for your own use, not for serving other people. If others will talk to your Mastan, read the API-key section in the developer notes.
- **Your data stays on your server.** This repository contains no keys, no user data and no server addresses.
- WhatsApp, email, the web chat with passkey login and the other parts are optional. Start with Telegram.

## Too much?

That is a fair reaction. Renting a server, paying in two places and keeping it all running is real work.

Open [mastan.ai](https://mastan.ai) and ask for a private Mastan. You get the same thing, set up for you.

## For developers

How it works inside, the folder map, model settings and every switch: [docs/DEVELOPERS.md](docs/DEVELOPERS.md).

## License

MIT, see [LICENSE](LICENSE). Security reports: see [SECURITY.md](SECURITY.md).

If Mastan is useful to you, a star on this page helps other people find it.
