# Changelog

## [0.1.4](https://github.com/geggo98/stream-deck-home-weather-station/compare/v0.1.3...v0.1.4) (2026-11-14)


### Bug Fixes

* harden flaky tests and set a 7-day dependency cooldown ([f5d8f3e](https://github.com/geggo98/stream-deck-home-weather-station/commit/f5d8f3e80d5e01ff8f865426a86481b1dbcbda8a))


### Build System

* bump the npm-dependencies group across 1 directory with 4 updates ([#5](https://github.com/geggo98/stream-deck-home-weather-station/issues/5)) ([199af57](https://github.com/geggo98/stream-deck-home-weather-station/commit/199af570de3ce75547b05ca5ee158deaa711179d))

## [0.1.3](https://github.com/geggo98/stream-deck-home-weather-station/compare/v0.1.2...v0.1.3) (2026-11-14)


### Features

* three dial types and a switch for what a rotation changes ([210d614](https://github.com/geggo98/stream-deck-home-weather-station/commit/210d6144d72a4d078a2d78d7b11af20a76fd915b))


### Bug Fixes

* cut key labels at 8 characters and leave no space before the ellipsis ([e535bd6](https://github.com/geggo98/stream-deck-home-weather-station/commit/e535bd609cfc57e445e654521dbd8943cc6770e7))

## [0.1.2](https://github.com/geggo98/stream-deck-home-weather-station/compare/v0.1.1...v0.1.2) (2026-11-14)


### Features

* add the Sensor Focus key, keep a following key's own value, run scripts with node ([89ac142](https://github.com/geggo98/stream-deck-home-weather-station/commit/89ac1422a73967168130dae044c2de53dbbbe63c))
* let npm run probe start itself through secretspec ([50eaa6a](https://github.com/geggo98/stream-deck-home-weather-station/commit/50eaa6a29e7d03349168dc4b26d8ae4cd6e076f3))


### Bug Fixes

* act on the pre-release review ([e1799d4](https://github.com/geggo98/stream-deck-home-weather-station/commit/e1799d48555a53e6027926350a3125fac9897431))
* give secretspec a reason when the probe starts itself ([e3b6918](https://github.com/geggo98/stream-deck-home-weather-station/commit/e3b69184903d218f1dd03d827fb1a073f3d4b4cf))


### Documentation

* record what the first live probe confirmed, and name the pressure keys ([f9a7019](https://github.com/geggo98/stream-deck-home-weather-station/commit/f9a7019588f19c1a0b9b2c25efe0533d62610c03))

## [0.1.1](https://github.com/geggo98/stream-deck-home-weather-station/compare/v0.1.0...v0.1.1) (2026-11-13)


### Features

* unofficial Stream Deck plugin showing weather station data ([0c62a6b](https://github.com/geggo98/stream-deck-home-weather-station/commit/0c62a6b53d5552553279dce5a03befe390638f8b))


### Bug Fixes

* act on the five-reviewer security and usability review ([3a2fdc8](https://github.com/geggo98/stream-deck-home-weather-station/commit/3a2fdc848c305d2497ce13d202c65bebe07d19aa))
* tell users to tick only read_station and shorten key labels to 9 characters ([711c124](https://github.com/geggo98/stream-deck-home-weather-station/commit/711c1243789be65935a40cb01cad1b115c454f76))


### Continuous Integration

* fix an invalid workflow step name and lint workflows with actionlint ([f72da9b](https://github.com/geggo98/stream-deck-home-weather-station/commit/f72da9bb232773427cbbc4619bb65714d7280e84))
* harden the supply chain, add zizmor, dependency review and a weekly scan ([40c5c2d](https://github.com/geggo98/stream-deck-home-weather-station/commit/40c5c2d098c4e6491c6a5e0aa9cd72e484aaccb4))
* make gitleaks recognise the real values of the local .env.local ([77dfae6](https://github.com/geggo98/stream-deck-home-weather-station/commit/77dfae62b12de39e11b4b81f795699def49bd28d))
* recognise secrets by shape: calibrated entropy, length and character classes ([0714c4b](https://github.com/geggo98/stream-deck-home-weather-station/commit/0714c4bc42d377c28c1fef8a075fa3668417265e))
