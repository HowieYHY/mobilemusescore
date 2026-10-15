# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Anyone who writes or receives scores in MuseScore and wants them on a phone or tablet: to read them,
hear them with MuseScore's own sounds, and practise a part. Most people use it **on the go**
(listening through a part on a commute, earphones in, the phone in a pocket or a hand) and **at
rehearsal** (reading from a phone or tablet held or on a stand, often with the sound off).

## Product Purpose

PocketScore opens MuseScore `.mscz` files on Android, iPhone, iPad and computers, draws them like
MuseScore 4.7.5 and plays them with the same sounds (MS Basic), with a mixer, speed, loop and notes
written on the score. Success: a score opened on the phone looks and sounds like it does on the
desktop, and practising a part needs no computer.

## Positioning

It runs MuseScore 4.7.5's own engraving and audio engine (compiled to WebAssembly) on the device, so
layout and sound match desktop MuseScore rather than an approximation, and it needs no account, no app
store and no internet after the first visit.

## Operating Context

- Installed from the browser: Chrome's *Install* on Android, *Add to Home Screen* on iPhone and iPad.
  One web app and one update path; it updates itself.
- Scores come from the device's files or another app's Share; nothing is uploaded.
- One hand on a phone, often while moving; small screens matter most.
- Also embedded, playing only, as a preview in the NUS Resonance website's library (`?embed=reso`).

## Capabilities and Constraints

- Matches desktop MuseScore 4.7.5 where desktop has an equivalent (sound menu, sound names, mixer
  rules); its source is in `third_party/musescore-4.7`.
- Notes and saved settings stay on the device only, never in the `.mscz`; there is no backup or export
  yet.
- One Save for the whole score (notes + mixer), asked only when leaving a score with unsaved changes.
- Music pauses when the app is left (today); background playback is a planned setting.
- Tips through a Stripe Payment Link, called tips, never donations.
- See `CLAUDE.md` for the full list of standing requirements.

## Brand Commitments

- Name: PocketScore. Not affiliated with or endorsed by MuseScore Ltd.
- Plain, friendly wording for non-technical readers; no jargon in the UI.

## Product Principles

1. Desktop MuseScore is the reference: match it where it has an equivalent, don't reinvent.
2. Don't clutter, especially on phones: controls most people don't need every time go behind a small
   button.
3. Honest controls: a control that can't work here is shown disabled and says why.
4. Nothing lost: drafts are kept quietly; the reader's data is never touched by tests or updates.
5. The music comes first: nothing on screen may make the sound stutter.

## Accessibility & Inclusion

- Works with touch, finger drawing (no stylus needed), mouse and keyboard.
- Respects the system's reduced-motion setting.
