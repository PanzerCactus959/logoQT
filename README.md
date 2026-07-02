# AI Logo Generator (Claude edition)

An open source logo generator, forked from [Nutlope/logocreator](https://github.com/Nutlope/logocreator)
and modified to generate logos as **hand-written SVG code via the Claude API**
instead of raster images via Together AI/Flux.

## What changed from the original

- `app/api/generate-logo/route.ts` — now calls Anthropic's Messages API
  (`@anthropic-ai/sdk`) and asks Claude to return a single `<svg>` element
  directly, instead of calling Together AI's image model.
- Output is **vector from the start** — no PNG, no separate vectorization
  step needed.
- Claude can render the company name as real, correctly spelled `<text>`,
  which raster diffusion models (Flux/DALL-E) routinely get wrong.
- `app/page.tsx` — renders the returned SVG markup directly and offers a
  `.svg` download instead of `.png`.
- Removed the Together AI dependency and branding.

## Known limitation

Claude cannot generate raster images — this fork intentionally trades "photo-real
AI art" for "clean, correctly-spelled, truly scalable vector logos". If you want
a raster illustration style logo, keep the original Together AI version instead.

## Tech stack

- [Claude](https://www.anthropic.com/claude) (Anthropic API) for logo generation
- [Next.js](https://nextjs.org/) with TypeScript for the app framework
- [Shadcn](https://ui.shadcn.com/) for UI components & [Tailwind](https://tailwindcss.com/) for styling
- [Upstash Redis](https://upstash.com/) for rate limiting (optional)
- [Clerk](https://clerk.com/) for authentication

## Cloning & running

1. Copy this project, `cd` into it.
2. Create a `.env` file (see `.env.example`) and add:
   - Your [Anthropic API key](https://console.anthropic.com/settings/keys): `ANTHROPIC_API_KEY=`
   - Your [Clerk](https://dashboard.clerk.com) publishable + secret keys
   - (optional) Upstash Redis credentials for rate limiting
3. Run `npm install` and `npm run dev` to install dependencies and run locally.
4. Open `http://localhost:3000`.

## Future Tasks

- [ ] Create a dashboard with a user's logo history
- [ ] Support SVG exports instead of just PNG
- [ ] Add support for additional styles
- [ ] Add a dropdown for image size (can do up to 1440x1440)
- [ ] Show approximate price when using your own Together AI key
- [ ] Allow the ability to upload a reference logo (use vision model to read it)
- [ ] Redesign popular brand’s logos with my logo maker and have it in a showcase
