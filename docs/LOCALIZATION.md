# Localization

Konofix Chat uses English as the canonical language for repository content, development documentation, CI output, release notes, issues, and project metadata.

The application itself is multilingual. On startup it should detect the operating-system/browser locale, normalize it to a supported language code, and load the matching UI language. If the detected language is not supported, Konofix must fall back to English.

## Current languages

- English (`en`) — mandatory fallback
- Polish (`pl`)
- Norwegian (`no`)
- German (`de`)
- French (`fr`)
- Spanish (`es`)
- Ukrainian (`uk`)

## Rules

1. English must always remain available and must be the fallback locale.
2. Repository-facing text stays in English.
3. New user-facing text should be added through the localization layer instead of being embedded directly in UI rendering code.
4. Missing translations must fall back to English rather than showing an empty label.
5. Locale selection must never affect peer protocol compatibility or room identifiers.
6. User-generated content is never translated automatically by the client.
7. Additional languages should be added without changing networking code.

## Migration plan

The first localization layer is compatibility-oriented and can translate existing runtime text while the application is being migrated. The target architecture is a typed message-key API with explicit parameters for dynamic values. This removes dependency on source-language text matching and makes translation completeness testable.

The CI project audit verifies that English fallback is configured and that repository documentation and workflow text remain English. It also reports the remaining Polish-specific characters in `src/main.ts` as a migration indicator. That indicator will become a strict gate when the runtime UI has completed the typed-key migration.

## Language selection

Automatic system-language detection remains the default behavior. A manual language selector is planned for the UX milestone; the user's explicit choice should then override automatic detection and be persisted locally.
