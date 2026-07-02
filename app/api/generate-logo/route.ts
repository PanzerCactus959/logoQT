import { clerkClient, currentUser } from "@clerk/nextjs/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import dedent from "dedent";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

let ratelimit: Ratelimit | undefined;

// Số phương án sinh ra mỗi lần bấm Generate — giống Looka/Brandmark cho
// khách nhiều lựa chọn thay vì 1 bản duy nhất. Tăng số này sẽ tăng thẳng
// chi phí API theo tỷ lệ tuyến tính (4 phương án ≈ 4 lần chi phí 1 phương án).
const VARIATION_COUNT = 4;

async function generateOneLogo(
  client: Anthropic,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    // temperature cao hơn mặc định để 4 lần gọi cùng prompt cho ra 4 bố cục
    // thực sự khác nhau, thay vì 4 bản gần như giống hệt nhau.
    temperature: 1,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text",
  );
  const raw = textBlock?.text ?? "";

  const match = raw.match(/<svg[\s\S]*?<\/svg>/i);
  if (!match) {
    throw new Error("NO_SVG_IN_RESPONSE");
  }
  return match[0];
}

export async function POST(req: Request) {
  const user = await currentUser();

  if (!user) {
    return new Response("", { status: 404 });
  }

  const json = await req.json();
  const data = z
    .object({
      userAPIKey: z.string().optional(),
      companyName: z.string(),
      selectedStyle: z.string(),
      selectedPrimaryColor: z.string(),
      selectedBackgroundColor: z.string(),
      additionalInfo: z.string().optional(),
    })
    .parse(json);

  // Add rate limiting if Upstash API keys are set & no BYOK, otherwise skip
  if (process.env.UPSTASH_REDIS_REST_URL && !data.userAPIKey) {
    ratelimit = new Ratelimit({
      redis: Redis.fromEnv(),
      // Allow 3 requests per 2 months on prod
      limiter: Ratelimit.fixedWindow(3, "60 d"),
      analytics: true,
      prefix: "logocreator",
    });
  }

  const client = new Anthropic({
    apiKey: data.userAPIKey || process.env.ANTHROPIC_API_KEY,
  });

  if (data.userAPIKey) {
    (await clerkClient()).users.updateUserMetadata(user.id, {
      unsafeMetadata: {
        remaining: "BYOK",
      },
    });
  }

  if (ratelimit) {
    const identifier = user.id;
    const { success, remaining } = await ratelimit.limit(identifier);
    (await clerkClient()).users.updateUserMetadata(user.id, {
      unsafeMetadata: {
        remaining,
      },
    });

    if (!success) {
      return new Response(
        "You've used up all your credits. Enter your own Anthropic API Key to generate more logos.",
        {
          status: 429,
          headers: { "Content-Type": "text/plain" },
        },
      );
    }
  }

  // Style descriptions rewritten for flat SVG output (the originals were
  // tuned for a raster diffusion model — "photorealistic", "cinematic" etc.
  // don't apply to a vector logo, so they're replaced with vector-appropriate
  // language). This is also where Claude has a real advantage over
  // Flux/DALL-E: it can render the company name as actual, correctly
  // spelled <text>, instead of garbled AI-generated lettering.
  const flashyStyle =
    "flashy and attention-grabbing: bold geometric shapes, high contrast, one or two vivid accent colors, sharp angular lines.";

  const techStyle =
    "modern tech aesthetic: precise geometric shapes, sharp clean lines, neutral palette with a single accent color, flat, no clutter.";

  const modernStyle =
    "modern and forward-thinking: flat design, simple geometric shapes, generous negative space, one or two colors.";

  const playfulStyle =
    "playful and lighthearted: rounded shapes, soft curves, bright but limited color palette.";

  const abstractStyle =
    "abstract and artistic: unique overlapping shapes and patterns, still simple enough to stay readable at small sizes.";

  const minimalStyle =
    "minimal and timeless: a single-color mark, maximum negative space, no unnecessary detail.";

  const styleLookup: Record<string, string> = {
    Flashy: flashyStyle,
    Tech: techStyle,
    Modern: modernStyle,
    Playful: playfulStyle,
    Abstract: abstractStyle,
    Minimal: minimalStyle,
  };

  const systemPrompt = dedent`You are a senior brand identity designer who writes production-quality SVG code by hand.

  Output ONLY a single <svg>...</svg> element and absolutely nothing else: no markdown code fences, no explanation, no text before or after the tag.

  Hard requirements:
  - viewBox="0 0 768 768", no width/height attributes on the root element
  - Only flat shapes: <rect>, <circle>, <ellipse>, <polygon>, <path>. No gradients, no filters, no raster <image>, no drop shadows.
  - If the company name is short enough to read cleanly, include it as a single <text> element, spelled EXACTLY as given, no other words. If it would look cluttered at a small size, omit the text and deliver an icon-only mark instead.
  - Balanced, centered composition that still reads clearly at 32x32px.
  - Every <text> element must set font-family and text-anchor="middle" explicitly.`;

  const userPrompt = dedent`Design a logo for a company called "${data.companyName}".

  Style: ${styleLookup[data.selectedStyle]}
  Primary color: ${data.selectedPrimaryColor.toLowerCase()}
  Background color: ${data.selectedBackgroundColor.toLowerCase()}
  ${data.additionalInfo ? `Additional info from the client: ${data.additionalInfo}` : ""}`;

  try {
    // Gọi lần đầu tiên riêng lẻ (không dùng Promise.allSettled) để các lỗi
    // "cứng" — API key sai, hết rate limit, mất mạng — được bắt và trả về
    // đúng status code ngay, thay vì bị nuốt lẫn trong 4 lỗi song song.
    const first = await generateOneLogo(client, systemPrompt, userPrompt);

    // Các phương án còn lại chạy song song. Dùng allSettled để 1 phương án
    // lỗi (Claude thỉnh thoảng trả sai định dạng) không làm hỏng cả batch —
    // khách vẫn nhận được các phương án còn lại thành công.
    const rest = await Promise.allSettled(
      Array.from({ length: VARIATION_COUNT - 1 }, () =>
        generateOneLogo(client, systemPrompt, userPrompt),
      ),
    );

    const svgs = [
      first,
      ...rest
        .filter(
          (r): r is PromiseFulfilledResult<string> => r.status === "fulfilled",
        )
        .map((r) => r.value),
    ];

    return Response.json({ svgs }, { status: 200 });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return new Response("Your API key is invalid.", {
        status: 401,
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (error instanceof Anthropic.RateLimitError) {
      return new Response(
        "Anthropic's API rate limit was reached. Please wait a moment and try again.",
        {
          status: 429,
          headers: { "Content-Type": "text/plain" },
        },
      );
    }

    if (error instanceof Anthropic.APIConnectionError) {
      return new Response(
        "Could not reach the Anthropic API. Check your network connection.",
        {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        },
      );
    }

    if (error instanceof Error && error.message === "NO_SVG_IN_RESPONSE") {
      return new Response(
        "Claude didn't return valid SVG this time. Please try generating again.",
        {
          status: 502,
          headers: { "Content-Type": "text/plain" },
        },
      );
    }

    throw error;
  }
}

export const runtime = "edge";
