# Pioneer Powersports — Lead Desk

A lead management tool for a powersports dealership, with admin and sales-rep
accounts, lead assignment, and a reps performance dashboard. Runs entirely on
your own server or machine — no cloud account, no external database.

- **Backend:** Node.js + Express. Leads and user accounts are stored in plain
  JSON files under `data/` — nothing to install or configure.
- **Frontend:** Plain HTML/CSS/JS (no build step), served by the same Express app.
- **Auth:** Username/password accounts with a secure session cookie. Passwords
  are hashed (scrypt) — never stored in plain text.

## Setup

You need [Node.js](https://nodejs.org) 18 or later. Then, in this folder:

```bash
npm install
npm start
```

Open **http://localhost:4000**. The very first time anyone opens the app, it
will ask you to create the **admin account** — that's you. Everyone after that
signs in with an account you create.

To use a different port: `PORT=5050 npm start`.

## Roles

**Admin**
- Sees every lead, regardless of who it's assigned to
- Creates and manages sales rep accounts (Manage Reps tab)
- Assigns or reassigns any lead to any rep
- Views the **Reps Dashboard** — pipeline totals, close rate, and status
  breakdown for every rep
- Can delete leads

**Sales Rep**
- Sees only the leads assigned to them
- Can log new leads (automatically assigned to themselves)
- Can update status and add notes on their own leads
- Cannot see other reps' leads, manage accounts, or delete leads

### Creating a rep account

As the admin, go to **Manage Reps → + New Rep Account**, enter their name,
pick a username, and set a temporary password. Share those credentials with
them directly (text, in person, etc.) — there's no email/invite step. They can
change their own password later by having you reset it from the same screen
(there's no self-service "change password" yet).

## Data & backups

Everything lives in two files:

```
data/leads.json    # every lead and its activity history
data/users.json    # accounts (admin + reps), with hashed passwords
```

Back these up however you'd back up any file on your server. To fully reset
the app (wipe all leads and accounts), stop the server and delete both files —
you'll be prompted to create a new admin account on next launch.

## Running it online

If you're exposing this outside your local network:

- Put it behind HTTPS (a reverse proxy like nginx, Caddy, or your host's
  built-in SSL). Once you're on HTTPS, start the server with
  `COOKIE_SECURE=true npm start` so session cookies are only ever sent over
  an encrypted connection.
- Sessions are kept in memory, so everyone is signed out if the server
  process restarts (deploys, crashes, server reboot). That's expected — just
  sign back in.

## Project structure

```
pioneer-powersports-lead-manager/
├── server.js          # Express server, auth, and REST API
├── package.json
├── data/
│   ├── leads.json     # created automatically
│   └── users.json     # created automatically
└── public/
    ├── index.html
    ├── styles.css
    └── app.js
```

## API reference

| Method | Route                    | Access        | Purpose                          |
|--------|---------------------------|---------------|-----------------------------------|
| GET    | `/api/auth/status`         | public        | Whether setup/login is needed     |
| POST   | `/api/auth/setup`          | public (once) | Create the first admin account    |
| POST   | `/api/auth/login`          | public        | Sign in                           |
| POST   | `/api/auth/logout`         | any            | Sign out                          |
| GET    | `/api/auth/me`              | any            | Current user                      |
| GET    | `/api/meta`                 | any            | Status/source/interest-type options |
| GET    | `/api/stats`                 | any            | Dashboard numbers (scoped to self for reps) |
| GET    | `/api/leads`                 | any            | List leads (reps see only their own) |
| POST   | `/api/leads`                 | any            | Create a lead                     |
| PUT    | `/api/leads/:id`             | any (own for reps) | Update a lead / reassign (admin only) |
| POST   | `/api/leads/:id/notes`       | any (own for reps) | Add a timestamped note             |
| DELETE | `/api/leads/:id`             | admin          | Delete a lead                      |
| GET    | `/api/users`                  | admin          | List all accounts                  |
| POST   | `/api/users`                  | admin          | Create a rep account               |
| PUT    | `/api/users/:id`               | admin          | Update name/active/password        |
| GET    | `/api/reps`                     | admin          | Active reps, for assignment        |
| GET    | `/api/reps/stats`               | admin          | Per-rep performance for the dashboard |

## Notes on scope

Built for a single dealership location. No multi-device write-locking beyond
what a single Node process naturally provides — fine for a small team hitting
it from a handful of devices. If this grows into a larger, always-on
multi-location system, swapping the JSON files for a real database (Postgres)
would be the next step — happy to help with that when you get there.
