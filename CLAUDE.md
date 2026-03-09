## Design Context

### Users

**Primary user: the developer who built this tool (personal/solo use).** Mindset: deep focus, high competence. They open Agent 86 in the middle of real work — not to explore or be entertained, but to get something done fast and get back to their editor. They have zero patience for UI that gets in the way. Cognitive overhead is the enemy. Every interaction should feel like the tool already knows what they want.

### Brand Personality

**Three words: calm, precise, invisible.**

The interface should recede. It should feel like a sharp tool that happens to have a UI — not a product trying to express itself. Voice is direct and terse. No enthusiasm, no filler copy. Labels say exactly what they mean.

### Aesthetic Direction

**Match VS Code natively.** The goal is for the panel to feel like it shipped with VS Code — not like a third-party extension bolted on. Follow VS Code UI conventions strictly: spacing, border-radius, font sizes, token usage. Use `--vscode-*` CSS variables exclusively; never hardcode colors.

**References (what to move toward):** VS Code's own panels, sidebar, and settings UI. Zed's command palette (precise, fast, no chrome). Helix's status bar (information density without clutter).

**Anti-references (what to avoid):** Chat apps (no bubbles, no avatars, no rounded-corner excess). AI product UIs with gradient text, glowing accents, glassmorphism, or hero metric cards. Anything that signals "this was made by AI for AI."

**Themes:** Respect the user's VS Code theme automatically. No separate theme toggle needed — the design system is the VS Code token system.

### Design Principles

1. **Earn every pixel.** No decoration for decoration's sake. If a visual element doesn't communicate information or improve usability, remove it. Whitespace is intentional, not leftover.

2. **VS Code token system is the only palette.** All color must come from `--vscode-*` CSS custom properties with appropriate fallbacks. Never introduce a new color that isn't a semantic VS Code token. This ensures theme compatibility and visual coherence.

3. **Hierarchy through weight, not color.** Primary/secondary/tertiary distinctions should be legible from shape and weight alone — filled vs. outline vs. ghost for buttons; font-weight and size for typography. Color is used to signal *state* (success, warning, error), not rank.

4. **Polish over flash.** Refined micro-interactions (subtle `ease-out` entrances, `translateY` nudges on hover, `opacity` transitions) are welcome when they reduce perceived latency or confirm actions. Animation should never draw attention to itself — it should make the interface feel faster and more confident.

5. **Safety is a design value.** The tool executes code and modifies files. The approval flow, button hierarchy (Deny as safe default), and risk-differentiated visual signals (neutral → amber → red left-border accents) are load-bearing design decisions, not cosmetic. Never flatten the visual distinction between safe and destructive actions.

### Technical Constraints

- Webview is self-contained: all styles live inline in `webview-ui/main.ts` (no external CSS file).
- Vanilla TypeScript + DOM — no frontend framework.
- Border-radius convention: `2px` for buttons/inputs, `3px` for cards/panels, `50%` for circular indicators.
- Spacing scale: 2, 4, 6, 8, 10, 12px — stay within this scale.
- Font sizes: `10px` (labels/badges), `11px` (secondary/hint), `12px` (card body), `13px`/`inherit` (base).
- Animations: always include a `prefers-reduced-motion` override.
