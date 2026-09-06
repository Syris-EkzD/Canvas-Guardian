# Canvas Guardian

Canvas Guardian is a self-hosted academic monitoring application designed to monitor Canvas LMS, send direct Telegram notifications, and synchronize assignment deadlines with Google Calendar.

It runs automatically on an Ubuntu server, so Canvas does not need to remain open in a browser.

## Features

- Monitors Canvas for new and upcoming activities
- Tracks unfinished and submitted assignments
- Sends activity and deadline alerts through Telegram
- Lists pending, daily, and weekly activities
- Retrieves recent Canvas announcements
- Synchronizes deadlines with Google Calendar
- Updates calendar events when deadlines change
- Removes calendar events after assignments are submitted
- Allows monitoring and calendar synchronization to be controlled through Telegram
- Runs automatically using systemd services and timers
- Prevents duplicate alerts and calendar events

## Telegram Commands

| Command | Description |
|---|---|
| `/start` | Start automatic Canvas monitoring |
| `/stop` | Stop automatic Canvas monitoring |
| `/pause` | Temporarily pause Canvas monitoring |
| `/resume` | Resume paused Canvas monitoring |
| `/status` | Show Canvas Guardian and calendar status |
| `/announcements` | Show recent Canvas announcements |
| `/pending` | Show all unfinished activities |
| `/today` | Show activities due today |
| `/week` | Show activities due within seven days |
| `/calendar on` | Enable calendar synchronization |
| `/calendar off` | Disable calendar synchronization |
| `/calendar status` | Show calendar synchronization status |
| `/help` | Show all available commands |

## How It Works

1. Canvas Guardian retrieves course and assignment information through the Canvas LMS API.
2. Assignment data and notification history are stored in a local SQLite database.
3. Telegram provides activity notifications and remote controls.
4. Google Calendar receives and updates assignment deadline events.
5. systemd runs the monitoring and calendar synchronization processes automatically.

## Technology

- Node.js
- Canvas LMS REST API
- Telegram Bot API
- Google Calendar API
- SQLite
- systemd
- Ubuntu Server

## Privacy and Security

Canvas Guardian uses read-only Canvas access and never automatically submits or modifies schoolwork.

API tokens, Google credentials, OAuth tokens, databases, and other private files are excluded from the Git repository through `.gitignore`.

## Project Status

Current stable version: `v0.2.0-calendar-stable`

The current version includes automatic Canvas monitoring, Telegram commands, and Google Calendar synchronization.
