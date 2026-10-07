# LINKOS Architecture Notes

## Core principle
The product is not a business-card scanner. It is an identity + encounter + relationship + action system. `Contact` is a canonical person record, `BusinessCard` is source evidence/snapshot, `Encounter` is the context of meeting, and `Relationship` is the ongoing state.

## Handoff rule
Browser capabilities do not permit a universal silent phone-to-phone NFC/Bluetooth exchange. The product must use progressive enhancement. Installed apps can use foreground BLE proximity with mutual approval. Non-users receive an ephemeral HTTPS link through native OS sharing or an NFC accessory; a short-code page is the next fallback; QR is final.

## Guest viral loop
A recipient never needs to create an account before reciprocal exchange. They can scan their own paper card, review extracted fields, consent, and exchange. A claim token lets them create/attach an account afterward.

## Consistency
All writes that trigger integrations publish an outbox event in the same DB transaction. Workers perform idempotent external sync.
