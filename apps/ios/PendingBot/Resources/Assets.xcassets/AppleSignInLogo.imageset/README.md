# AppleSignInLogo asset

This imageset is intentionally empty in source control. The actual artwork lives behind Apple Developer auth and can't be fetched by an automated script.

## How to populate

1. Sign in at https://developer.apple.com/design/resources/
2. Download "Sign in with Apple" → choose the **logo-only** white-on-transparent PDF (vector preferred) or the @1x/@2x/@3x PNGs.
3. Drop the file(s) into this directory and update `Contents.json`:
   - Single PDF (preserve vector): add `"filename": "logo.pdf"` to the universal entry, and add `"properties": { "preserves-vector-representation": true }`.
   - Or three PNGs: name them `logo.png`, `logo@2x.png`, `logo@3x.png` and reference them in the three scale entries.

## Constraints (Apple HIG)

- Use Apple's logo-only white asset on a black background. Do not recolor or add padding.
- Do not crop the artwork (its built-in padding is intentional).
- See https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple/overview/buttons/

Until this asset is provided, `WelcomeView` falls back to the `applelogo` SF Symbol so the button is still visible during dev.
