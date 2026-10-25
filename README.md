![Game library](banner.svg)

# Game library

All your games in one place. Your Steam library without signing in: games, size, drive, playtime and running downloads. Plus a storage doctor that shows what eats space, save backups after every session (Ludusavi list), price alerts for your watchlist, playtime statistics, screenshots, “What should I play tonight?” and your own server for your games in one click. Epic Games and GOG are read from this PC; your Steam account and itch.io can be connected once for the games you own but have not installed.

[Deutsch](README.de.md) · An official [Hostwerk](https://github.com/Passimoritz/hostwerk-public) extension (native extension, Hostwerk 3.0 or newer)

![Screenshot](docs/screenshot.png)

## What it does

- **Library without an account** – finds Steam by itself (Windows registry and usual folders, Linux `~/.steam`, `~/.local/share/Steam`, Flatpak, Snap) and reads every library on every drive: installed games with cover, size, drive, build, update state, live download progress, playtime and “last played” per Steam account. Covers come from Steam’s own image cache on this PC; only what is missing is fetched once from Steam’s CDN.
- **Accounts & other stores** (tab “Accounts”) – connect once, it stays connected: **Steam** through the official Steam sign-in (OpenID – Hostwerk only learns your SteamID, never your password) plus your own free Web API key, **itch.io** with an API key. **Epic Games** and **GOG** are read from their launchers on this PC without any sign-in. Games you own but have not installed appear under “More games” below the library, filterable per store, with Install (Steam), Play and Open folder (Epic, GOG) or a link (itch.io). Refreshes by itself every 6 hours; keys are stored encrypted and never reach the browser.
- **Steam status** – is Steam running, which game is being played, which game is downloading (with percent) and when Steam has planned an update.
- **Storage doctor** – a space map per drive (biggest games as stripes) and findings: never started, long unplayed (default 180 days), played a lot but lying on a hard disk while the SSD has room, drive almost full, leftovers of uninstalled games (workshop, shader cache, Proton prefix, unfinished downloads). Hostwerk deletes nothing itself: uninstalling opens Steam’s own dialog, leftovers open in the file manager.
- **Save time machine** – where each game keeps its saves comes from the open [Ludusavi list](https://github.com/mtkennerly/ludusavi-manifest) (made from the PCGamingWiki, updated daily). When a game ends, Hostwerk backs up its saves automatically; every file is stored once (unchanged saves cost no space). Restoring always makes a backup first and refuses while the game is running. Shows which games keep their saves **only on this PC** (no Steam Cloud, no backup yet). Linux: Windows games are also looked for in their Proton prefix. The backups appear in Hostwerk’s backup center and in the external backup.
- **Deals & watchlist** – add games from the Steam store search or take over your public Steam wishlist; current price, discount, lowest price seen, price history, target price per game, one bundled notification when something goes on sale. Plus the library value (today’s regular store price of your installed games – honestly labelled, not what you paid).
- **What should I play tonight?** – three ideas from your own library by mood: unfinished, old favourites, never started, short session, with friends (co-op categories) – “Roll again” brings others. No account, no AI.
- **Statistics** – playtime per week and per day, most played of the last 30 days, days in a row, recent sessions.
- **Screenshots** – gallery of your Steam screenshots per game, large view, open folder.
- **Own server for your games** – with the extension “Game servers”: finds which installed games have a dedicated server tool and sets it up in one click (SteamCMD). Appears as the tab “Your games” under Game servers and in the details of a game.
- **Dashboard tile** – playing right now / last played, updates, downloads, almost full drives.

## Install

In Hostwerk: **Extensions → Discover** and click “Install”.

Native extensions run as part of Hostwerk (own server and interface part). That is why Hostwerk only installs them from the official catalogue (with checksum) or in developer mode.

## Data sources – and why nothing needs maintenance

| What | Source | Key? |
|---|---|---|
| Library, playtime, downloads, screenshots, covers | Steam’s own files on this PC (`libraryfolders.vdf`, `appmanifest_*.acf`, `localconfig.vdf`, `appcache/librarycache`) – read only | no |
| Where games keep their saves | Ludusavi list (raw.githubusercontent.com), at most once a day with `If-None-Match` (usually 304), stored gzipped | no |
| Prices, genres, search | Steam store (`store.steampowered.com/api/appdetails`, `storesearch`), throttled, prices twice a day | no |
| Public wishlist | `api.steampowered.com/IWishlistService/GetWishlist` | no |
| Missing covers | Steam CDN through Hostwerk’s image cache | no |
| Games you own (optional) | `api.steampowered.com/IPlayerService/GetOwnedGames` with your own Web API key after signing in through `steamcommunity.com/openid` | your own |
| itch.io (optional) | `api.itch.io/profile/owned-keys` with your own API key | your own |
| Epic Games, GOG | Epic launcher manifests (`*.item`) and the GOG entries in the Windows registry – read only | no |
| Server tools | the extension “Game servers” (`ctx.games`) – feature detection | – |

There is no list of games inside the extension. Offline mode is respected: nothing is asked online, everything local keeps working.

## Permissions

- `native` – reads Steam’s files and the save folders, writes only to its own data folder; opens `steam://` links (fixed list: play, details, uninstall, validate, store …) and folders the extension found itself, only on your click.
- `network` – exactly these addresses: `store.steampowered.com` (prices, genres, search), `api.steampowered.com` (public wishlist), `shared.akamai.steamstatic.com` and `cdn.cloudflare.steamstatic.com` (covers missing on this PC), `raw.githubusercontent.com` (Ludusavi list), `steamcommunity.com` (confirm the Steam sign-in), `api.itch.io` (your itch.io games, only when connected).
- `read:games` – sees the game servers of the extension “Game servers” (which server of a game already exists).

## Limits (honest)

- **No achievements.** Games you own but did not install need the Steam sign-in plus your own Web API key (Steam offers no other lasting way); without them the extension shows what is installed on this PC.
- Playtime statistics start on the day the extension is installed (Steam only stores totals). Sessions appear when Hostwerk runs while you play.
- Saves in the Windows registry (a few older games) are named, not backed up. Games missing from the Ludusavi list are shown as “location unknown”.
- `steam://` links act on the PC Hostwerk runs on – from another device they open nothing.
- Prices: the store limits requests without a key; Hostwerk pauses for 15 minutes when Steam asks for it. Wishlists must be public.
- Epic and GOG: only what is installed on this PC (both offer no lasting official way to list a whole account). Other launchers (EA app, Ubisoft Connect, Battle.net) are not covered yet.

## Develop

```bash
node --test tests/*.test.js          # tests (fake Steam installation, no real data)
node build-native.js .               # build the interface (sdk/build-native.js from hostwerk-public)
node check.js . --strict             # same check as the catalogue (sdk/check.js)
```

Interface source in `ui/src`, server part in `server/`. Texts in the code are English, German is in `locales/de.json`.

## License

MIT
