# Localization

Konofix Chat uses English as the canonical language for repository content, development documentation, CI output, release notes, issues, and project metadata.

The application itself is multilingual. On startup it detects the operating-system/browser locale, normalizes it to a supported language code, and loads the matching UI language. If the detected language is not supported, Konofix falls back to English.

## Current languages

- English (`en`) — mandatory fallback
- Polish (`pl`)
- Norwegian (`no`)
- German (`de`)
- French (`fr`)
- Spanish (`es`)
- Ukrainian (`uk`)

## Runtime architecture

Runtime UI text is addressed through the typed `MessageKey` + `t()` API in `src/i18n.ts`. Dynamic values use explicit named parameters such as `{nick}`, `{room}`, `{file}`, and `{error}`. Translation dictionaries may omit a key; an omitted entry falls back to the canonical English value for that key.

The earlier compatibility translator that walked the DOM and matched Polish source text has been removed. `src/main.ts` now requests explicit message keys when rendering labels, validation messages, network state, transfer status, prompts and system notifications. This keeps user-generated content outside the localization system and avoids translating arbitrary DOM text.

## Rules

1. English must always remain available and must be the fallback locale.
2. Repository-facing text stays in English.
3. New user-facing text must be added through the typed localization layer instead of being embedded directly in UI rendering code.
4. Missing translations must fall back to English rather than showing an empty label.
5. Locale selection must never affect peer protocol compatibility or room identifiers.
6. User-generated content is never translated automatically by the client.
7. Additional languages should be added without changing networking code.
8. Dynamic values must use named parameters rather than source-text replacement.
9. The DOM/source-language compatibility translator must not be reintroduced.

## CI enforcement

The project audit verifies that English fallback is configured, the `MessageKey` type and `t()` runtime API exist, repository documentation and workflow text remain English, and the removed compatibility translator does not return. It also fails if Polish-specific UI literals are reintroduced into `src/main.ts` or if the main renderer stops consuming the localization API.

TypeScript provides an additional compile-time guard: literal calls such as `t('rooms.create')` must reference a key declared by the canonical English dictionary.

## Language selection

Automatic system-language detection remains the default behavior. A manual language selector is planned for a later UX milestone; the user's explicit choice should then override automatic detection and be persisted locally.
