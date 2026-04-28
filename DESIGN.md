Hollo design system
===================

This document defines the visual design language and front-end conventions
of Hollo's web pages.  Hollo is primarily a headless ActivityPub server, but
it ships a small surface of server-rendered HTML pages — the admin
dashboard, account profiles, individual posts, the OAuth consent screen,
and a handful of utility screens.  This document specifies how those pages
should look, feel, and be implemented.

The design language values *simplicity* and *modernness* over decoration.
Surfaces are achromatic by default; color only enters the page through
the account owner's chosen *theme color*, which tints the profile and
post pages of that account.  The visual center of every page is the
content the user came for, not the chrome around it.


Brand identity
--------------

The name *Hollo* is always written with a capital “H” and lowercase
“ollo”.  The mark is a circular badge with the wordmark “Hollo” inside,
distributed as two SVGs at the project root:

 -  *logo-black.svg* — for use on light backgrounds.
 -  *logo-white.svg* — for use on dark backgrounds.

Both files are served from */public/* and embedded inline only when an
icon-sized rendering is needed.  Don't recolor the mark; switch between
black and white based on the surrounding surface.

The voice of the UI is short and matter-of-fact.  Prefer plain English
sentences over imperative shouts; trust the reader.


Design principles
-----------------

 -  *Simplicity*: prefer fewer controls, fewer borders, fewer surfaces.
    Visual hierarchy comes from typography and spacing, not from boxes.
 -  *Modernness*: use modern CSS features (logical properties, OKLCH
    color, container queries when needed) but never at the cost of
    progressive degradation.
 -  *Content first*: text columns stay at a comfortable measure.  Media
    expands only when it earns the room.
 -  *Lightweight SSR*: pages are server-rendered with Hono JSX and ship
    zero client-side JavaScript by default.  Never reach for a runtime
    framework to solve a styling problem that CSS can answer.
 -  *Accessibility*: every interactive element is keyboard-reachable, has
    a visible focus state, and meets WCAG AA contrast in both light and
    dark color schemes.


Color system
------------

### Neutral palette

The default surface is achromatic.  Hollo uses UnoCSS's *Wind4* neutral
scale (*neutral-50* through *neutral-950*) for backgrounds, borders,
surfaces, and text.  No saturation enters a page until a theme color is
applied.

| Role            | Light scheme  | Dark scheme   |
| --------------- | ------------- | ------------- |
| Page background | *neutral-50*  | *neutral-950* |
| Surface         | *white*       | *neutral-900* |
| Subtle border   | *neutral-200* | *neutral-800* |
| Body text       | *neutral-900* | *neutral-100* |
| Muted text      | *neutral-500* | *neutral-400* |

### Account theme colors

Each account owner picks a theme color from a fixed set of twenty named
hues, defined as the *theme\_color* PostgreSQL enum in *src/schema.ts*:

~~~~
amber  azure  blue   cyan    fuchsia  green   grey    indigo
jade   lime   orange pink    pumpkin  purple  red     sand
slate  violet yellow zinc
~~~~

The palette comes from Pico CSS's named color palette.  Each hue is
expressed at nine tonal stops (*50, 100, 200, 300, 400, 500, 600, 700,
800, 900*), stored as RGB triples in *src/theme/colors.ts*.

### CSS variable injection

The theme color is applied through CSS custom properties on the
`<html>` element.  *Layout.tsx* reads the account's *themeColor* and
emits inline declarations:

~~~~ html
<html style="--theme-50:247 248 250; --theme-100:...; ... --theme-900:...">
~~~~

The UnoCSS configuration exposes these variables as a generic *brand*
color token:

~~~~ ts
theme: {
  colors: {
    brand: {
      50: "rgb(var(--theme-50) / <alpha-value>)",
      // ... 100 through 900
      DEFAULT: "rgb(var(--theme-500) / <alpha-value>)",
    },
  },
}
~~~~

This means components write `bg-brand`, `text-brand-700`,
`border-brand-200`, and so on, without ever knowing which of the twenty
hues is currently active.  No safelist is needed because no class name
varies with the theme color.

### Dark mode

Dark mode follows the operating system via `prefers-color-scheme: dark`.
There is no manual toggle in the first pass; that may be added later
without changing the underlying tokens.  All component recipes specify
both light and dark variants up front.


Typography
----------

### Type families

| Role     | Family                                         | Source                    |
| -------- | ---------------------------------------------- | ------------------------- |
| Sans     | *Inter*                                        | bunny.net (Google mirror) |
| Sans CJK | *Noto Sans KR*, *Noto Sans JP*, *Noto Sans SC* | bunny.net                 |
| Mono     | *JetBrains Mono*                               | bunny.net                 |

Fonts are loaded through UnoCSS's *presetWebFonts* with the *bunny*
provider, which is a privacy-respecting mirror of Google Fonts.  The CSS
font stack lists Inter first, then the three Noto Sans CJK families, and
falls back to the system stack so initial paint never blocks on a
network request.

### Type scale

Use the Wind4 default scale unchanged (*text-xs* through *text-5xl*).
Body copy is *text-base* with *leading-relaxed*.  Headings step down by
one level per nesting depth.

### Long-form content

Rendered Markdown — post bodies, account bio fields, reply chains — is
wrapped in the *prose* class from *presetTypography*, with
*prose-neutral* and *dark:prose-invert* variants.  Inline code uses the
mono family; block code is rendered through Shiki and keeps its own
colors.


Spacing and layout
------------------

The spacing scale is Wind4's default 4 px grid.  Use multiples of *2*
(*0.5rem*), *3*, *4*, *6*, *8*, *12*, and *16* for almost all gaps.

Page widths:

 -  Reading column (post body, profile bio, settings forms): *max-w-2xl*
    (~42 rem).
 -  Dashboard column (timelines, account list): *max-w-3xl* (~48 rem).
 -  Wide chrome (top nav, footer): full width with internal *max-w-5xl*.

Breakpoints follow the Wind4 defaults (*sm* 640 px, *md* 768 px, *lg*
1024 px, *xl* 1280 px).  Mobile is the design start point; widen by
adding `md:` and `lg:` variants.


Iconography
-----------

Hollo uses a single icon collection: *Lucide*, surfaced through
UnoCSS's *presetIcons* with the *@iconify-json/lucide* package.  Icons
are written as CSS classes:

~~~~ tsx
<span class="i-lucide-bell text-lg" aria-hidden="true" />
~~~~

Sizing follows the surrounding text size by default (*1em*).  Icons
inherit *currentColor*, so they tint with the parent's text color
(including the theme color where applicable).  Decorative icons get
`aria-hidden="true"`; meaningful icons have a paired text label or
*aria-label*.


Components
----------

### Button

Three visual ranks exist:

 -  *primary*: solid theme-colored background, white text.  At most
    one per pane.
 -  *secondary*: neutral surface, neutral border, theme-colored text on
    hover.
 -  *ghost*: no background, text-only; used in dense toolbars and inline
    actions.

A *danger* variant in red is available for destructive submits.  Sizes
are *sm*, *md* (default), and *lg*.  All buttons share the same focus
ring and disabled state.

### Form field

Each field is a labelled stack: *label → control → optional hint or
error*.  Labels are above the control, never floating.  Required fields
get a small “required” badge to the right of the label rather than an
asterisk.  Errors are red and live below the control.

### Top nav

The dashboard's top nav is a single row: logo on the left, primary
navigation in the center, and the account chip + sign-out button on the
right.  On small screens the center links collapse into a sheet.

### Card and article

Posts and notifications are rendered as *articles* — semantic HTML, no
visible card border.  A subtle bottom divider separates each entry in a
list.  Avatar, display name, handle, timestamp, and content stack
vertically on mobile and arrange into a media object on *md*.

### Avatar

Always circular.  Sizes: *sm* 1.5 rem, *md* 2.5 rem, *lg* 4 rem,
*xl* 6 rem.  Profile headers use *xl*; comment threads use *sm* or *md*.

### Footer

A single line of muted text at the bottom of every page: software name,
version, and a link to the source.  No social icons.

### Empty state

Centred icon (Lucide), one-line headline, optional subline, optional
primary call-to-action.  No illustrations.


Motion
------

Motion is reserved for state feedback, not decoration.  Allowed
transitions:

 -  *colors*: 150 ms, on hover and focus changes.
 -  *opacity*: 150 ms, on disclosure toggles.
 -  *transform: scale*: 100 ms, on press of a button.

Disable all transitions when *prefers-reduced-motion: reduce* is set.
Page transitions and route animations don't exist; SSR renders the new
page directly.


Accessibility
-------------

 -  Maintain WCAG AA contrast in both light and dark schemes.  Theme
    colors pass contrast against neutral surfaces at the *600* and
    *700* stops; lighter stops are background-only.
 -  Every focusable element has a visible *focus-visible* ring (a 2 px
    ring in *brand-500* or *neutral-500*, offset by 2 px).
 -  Use semantic HTML: *button* for buttons, *a* for navigation,
    *form*/*fieldset*/*label* for forms, *article* for individual posts,
    *nav* for navigation regions.
 -  The *html* element's *lang* attribute reflects the page locale where
    a content language is known.
 -  Decorative imagery uses *alt=“”* or *aria-hidden*.  Meaningful
    imagery has descriptive alternative text.


Implementation guide
--------------------

### Stylesheet pipeline

UnoCSS scans every *.tsx* and *.ts* file under *src/* via *@unocss/cli*
and writes a single static stylesheet to *src/public/uno.css*.  In
development, *concurrently* runs the UnoCSS watcher alongside *tsx
watch*.  In production, *pnpm build* runs *unocss* once before *tsdown*.
The stylesheet is served as a static asset, not bundled with the
application code, and the Layout component links it like any other
*.css* file.

### Layout shell

*src/components/Layout.tsx* is the only place that emits *html*, *head*,
and *body*.  Pages return a Layout-wrapped tree from their handler.
Layout is responsible for:

1.  Linking */public/uno.css*.
2.  Computing the inline CSS variable string from the requested
    *themeColor* and putting it on *html*.
3.  Setting *lang*, page metadata (title, OG tags, canonical), and
    favicons.

### Theme tokens

*src/theme/colors.ts* exports a frozen object mapping each
*ThemeColor* enum value to its 50–900 RGB triples.  When changing the
palette, edit only this file; nothing else needs to know about the
twenty hues by name.

### Forms

Forms use a small helper component family (planned: *Field*, *Label*,
*Input*, *Hint*, *Error*).  These compose plain HTML controls with the
appropriate UnoCSS classes; they never wrap a third-party input
library.

### Prose content

Apply the *prose prose-neutral dark:prose-invert* class set to the
container that holds rendered Markdown.  Don't apply *prose* to
arbitrary blocks of UI; it is intended for long-form text only.

### Variant groups

The UnoCSS *variantGroup* transformer is enabled.  Group related
variants:

~~~~ tsx
<button class="rounded-md px-4 py-2 (bg-brand text-white hover:bg-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500)">
~~~~

Use this judiciously; long flat class lists are still fine when they
are easier to read.
