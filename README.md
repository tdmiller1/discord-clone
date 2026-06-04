# discord-clone

No fluff, "discord server" clone.

## High Level

Artifacts
1. Discord server image configuration
    - Docker container to be run on any bare metal server with low effort config
2. Discord client application exe
    - Easy for anyone to download and install
3. Discord client application (exe but for Linux)
    - Easy for anyone to download and install

Assume very simple architecture, 1 server only needs to support up to 10 clients. E.g One technically minded user spins up the server and deals out the authentication tokens to be used during the Client exe install

## Features

- Basic text channel
- Ability to create new text channels
- Basic VOIP channel
- Ability to view + send images