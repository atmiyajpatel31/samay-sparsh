# Samay Sparsh

A timing game for exactly 3 players. A shared target time appears; each player
taps to start their timer and taps again to stop as close to the target as they
can. Closest player wins the round; most round wins takes the game.

Colours, type and card shapes follow the Chalo Ramiye reference screenshot.

## Run it

```
node server.js
```

It prints a `localhost` URL and a Wi-Fi one:

```
  Samay Sparsh — http://localhost:5173
  on this Wi-Fi:  http://192.168.1.232:5173
```

**To play on real phones, no deploy needed:** put every phone on the same Wi-Fi
and open the Wi-Fi URL. One player taps *Start a Party* and reads out the
6-digit code; the others tap *Join a Party* and enter it.

`PORT` is read from the environment, so hosts like Render work unchanged.

## Deploying to Render

`render.yaml` configures the service — **New > Blueprint**, pick the repo, done.
Three things about the free plan that will bite otherwise:

- **It sleeps after ~15 min idle.** The first load then takes ~50s. Open the URL
  yourself before people arrive.
- **Rooms live in memory.** A deploy or a sleep wipes parties in progress.
- **One instance, always.** Players in a party must land on the same process.
  Scaling out needs room state in something shared (Redis) first.

## Files

| File | What's in it |
|---|---|
| `index.html` | Markup for every screen |
| `styles.css` | Design tokens + every screen's styling |
| `net.js` | Room transport and host authority. **The swap point.** |
| `game.js` | Game rules, tap engine, screen flow |
| `server.js` | Zero-dependency relay: SSE down, POST up |

## Flow

Menu → Setup → Lobby → Instructions (animated) → Practice → Waiting →
5 official rounds (round → results) → tie-breakers as needed → Final.

No 3-2-1 countdowns anywhere. Every round opens directly and each player taps
to start their own timer whenever they're ready.

## Transport — read this before integrating

`net.js` is the only file that knows how bytes move between players. `game.js`
touches it through four methods and nothing else:

```js
net.create(name)        // -> { code }
net.join(code, name)    // -> { code }, rejects on bad code / full room
net.send(type, payload) // broadcast to the room
net.on(type, handler)   // subscribe
```

The current implementation uses `BroadcastChannel`, which carries messages
**between tabs of one browser on one machine**. That is enough to play and test
the whole game loop with no server, but it is not real cross-device multiplayer.
To ship: replace the body of `Transport` with your socket calls, keep those four
signatures, and `game.js` needs no changes.

Two properties any replacement must preserve:

1. **`send()` must not deliver synchronously.** Callers rely on `send()`
   returning before any handler runs. The local echo goes through
   `queueMicrotask` for exactly this reason — delivering inline lets a handler
   fire midway through the function that sent the message and get clobbered by
   the lines after the `send()` call. (This was a real bug during development:
   pressing *Start Game* opened Round 1 and then immediately overwrote it with
   the waiting screen.)
2. **Host authority.** Exactly one peer (the room creator) generates targets and
   tallies wins; everyone else renders what the host sends.

### Host authority

The host is the only peer that calls `makeTarget()`. It generates one target per
round and broadcasts it, so all players are guaranteed the same number — targets
are never generated per-device. The host also owns the win tally and decides
when each round opens.

If you move to a server, the server should take this role. Today the host is a
player's device, which means it is trusted; a server-authoritative version also
gets you protection against a tampered client.

## Rules encoded

- Targets: 4.00–10.00s inclusive, 2 decimals, new one every official and
  tie-breaker round. Practice is fixed at 5.00s and counts toward nothing.
- Practice is a single attempt: once a player stops the timer, *Start Game* is
  the only way on. (Deliberate — the original spec allowed retries.)
- Difference is `|stopped − target|`, so stopping early and late are treated
  identically.
- Ties are compared on the **rounded 2-decimal** difference, not raw
  milliseconds — so a tie on screen is a tie in the tally, and no invisible
  hundredth decides a round. Every player tied at the smallest difference wins
  the round.
- After 5 rounds, most wins takes it. Any tie at the top sends **only** the tied
  players to a tie-breaker, repeating until someone wins outright. A tie-breaker
  decides the winner without adding to the win tally.
- Results are hidden until every player in the round has stopped.

## The tap engine

Start and stop are taps anywhere in the main game area — no small buttons. The
guarantees, all enforced by the state machine in `game.js`:

- The starting tap cannot also stop the timer.
- A long press cannot register as two taps.
- An accidental double-tap cannot immediately stop the timer.
- Once stopped, the result is locked.

How: a tap can only stop the timer from the `armed` state, and `armed` is only
reachable by fully lifting the finger (`pointerup`) and then waiting out
`ARM_DELAY_MS` (320ms). That delay is far below any real attempt — the shortest
legal target is 4 seconds — but long enough to absorb a fumble.

Times are measured with `performance.now()` and displayed to 2 decimals.

## Verified

Driven end-to-end in-browser across three tabs: join-by-code (including a wrong
code and a rejected 4th player), practice, a full 5-round game, a within-round
tie awarding both players a win, a three-way tie-breaker, a partial tie-breaker
with a player sitting out, the final screen, and Play Again. Target generator
checked over 200k draws: 0 out of range, 601 distinct values, both endpoints
reachable.

Note when testing with tabs: Chrome throttles timers in backgrounded tabs, so a
background player's stop times will read long. Keep the tab you're timing in the
foreground. Real players on real devices are unaffected.
