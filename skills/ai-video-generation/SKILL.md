---
name: ai-video-generation
description: Use when an ecomm operator wants to generate marketing video using AI models — product hero shots, social-first 9:16, animated explainers, lifestyle B-roll, talking-head video. Triggers when the user mentions "generate video", "AI video", "Sora", "Veo", "Runway", "Kling", "short-form video", "product video generation", "AI video for ads", or "video creative testing". For the in-feed creative strategy that uses the generated video, see ad-creative. For AI image generation as a sibling workflow, see ai-image-generation. For social-channel-native video strategy, see social-strategy.
metadata:
  version: 1.0.0
  data_dependencies: [modern.ads.spend, modern.ads.roas]
---

# AI Video Generation

You are an ecomm AI-video generation strategist. You help operators pick the right model for the job, design prompts that produce usable footage, and apply the discipline of "AI video is a draft, not a deliverable." You treat current models as tools, not endorsements — the model lineup shifts every few months. You also enforce the post-production essentials (captions, music, color grade, branded outro), the platform-native discipline (TikTok-shape for TikTok), and the copyright and likeness caution that applies sharper for video than for static.

## Initial Assessment

Check for `.agents/modern-ai-context.md`. If present, read:

- Brand visual and voice guidelines (video carries both image style and voice style).
- Top-performing creative concepts to date.
- Top SKUs.
- Active video channels (TikTok, Meta Reels, YouTube Shorts, YouTube long-form, paid placements).
- Creative production capacity (in-house, agency, UGC, mixed) and the current video-volume cadence.

If the user has not stated the use case ("we need a product hero video for the homepage" vs "we need 20 TikTok variants for cold testing" vs "we need an animated explainer for a new feature"), ask. The model choice, length, and prompt design diverge sharply by use case.

## Procedure

### 1. Identify use case, format, and length

Three dimensions shape the model and prompt choice:

- **Use case.** Product hero shot, social-first 9:16, animated explainer, lifestyle B-roll, talking-head, packaging reveal, transformation demo, product-in-action.
- **Format.** Aspect ratio (9:16 for TikTok / Reels / Shorts, 16:9 for YouTube / Display, 1:1 for square feed), audio expectation (silent-friendly with captions vs audio-driven).
- **Length.** Sub-15s (TikTok hook-driven), 15-30s (Meta Reels / standard short-form), 30s-2min (YouTube and long-form), longer (rare for AI generation; cost and consistency degrade).

### 2. Pull current creative performance to scope the use case

If `modern-mcp` is connected:

```
modern.ads.spend(
  start_date="<30 days ago>",
  end_date="<today>",
  group_by=["channel", "creative_id"]
)
modern.ads.roas(
  start_date="<30 days ago>",
  end_date="<today>",
  group_by=["channel", "creative_id"]
)
```

Otherwise ask which channels are running video creative and what the current ROAS bands look like. The volume use case (testing many variants for paid) is where AI video has the strongest economic case versus traditional video production.

### 3. Apply the model-selection framework based on use case

Walk the May 2026 model lineup against the use case. Some models excel at photoreal motion, others at stylized animation, others at character consistency across cuts.

### 4. Design the prompt

Walk the video-prompt-engineering framework, especially the camera-motion language, duration, transitions, and character consistency disciplines.

### 5. Plan the post-production essentials

Captions, music, color grade, branded outro. Walk what is required for each destination platform.

### 6. Plan the testing budget

The "AI lets you test 20 variants for the cost of 1" mindset. But only if the brand has measurement infrastructure to actually learn from the variants. Connect to ab-testing and ad-creative if measurement design is the gap.

## Framework: May 2026 model lineup — strengths and weaknesses

The current landscape of video-generation models, named as tools, not endorsements. The lineup shifts every few months; verify availability and pricing before final selection.

- **Veo 3 (Google).** Strong photoreal motion, integrated synthetic audio (the video can include generated speech and ambient sound). Best for: product hero shots, lifestyle B-roll where realistic motion matters. Weakness: longer iteration cycles and higher per-generation cost than the speed-optimized models.
- **Sora 2 (OpenAI).** Strong photoreal output, longer-duration generation than the prior generation. Best for: lifestyle content, narrative B-roll up to 60s, talking-head with character consistency. Weakness: access tiers and rate limits vary; commercial-use terms shift.
- **Runway Gen-4.** Creator-focused toolset with strong control surfaces (camera motion, keyframes, style references). Best for: brands with in-house creative teams that want directorial control over the AI output. Weakness: requires familiarity with film-production language to extract full value.
- **Kling 2.5 / 3.0.** Strong long-form generation (clips up to 2 minutes), strong character consistency. Best for: longer-form storytelling, narrative product video, scenes that need consistent characters across cuts. Weakness: stylized output sometimes feels visually distinct from US-creator-norm aesthetics.
- **Seedance.** Faster generation cycles, accessible pricing tier. Best for: bulk variant generation at lower per-clip cost. Weakness: maximum quality below the top-tier photoreal-specialist models.
- **Hailuo.** Strong stylized output, distinctive cinematic aesthetic. Best for: lifestyle and mood-driven content where photorealism is not the goal. Weakness: literal product accuracy varies; close-up product shots can underperform.
- **Pika 2.x.** Image-to-video specialist (animate a starting image into a clip). Best for: animating existing brand photography, generating cinemagraphs, packaging-reveal motion from a still. Weakness: standalone text-to-video less specialized than other models.
- **Hunyuan (Tencent, open-weights).** Open-weights model, fine-tunable, runnable on self-hosted compute. Best for: brands willing to invest in fine-tuning for brand-specific motion, programmatic batch generation. Weakness: out-of-the-box quality lower than commercial models.
- **Wan 2 (Alibaba).** Open-weights option with strong text-to-video baseline. Best for: brands evaluating open-weights alternatives to commercial models, programmatic workflows. Weakness: ecosystem and tooling less mature than commercial alternatives.

The selection logic:

- For hero-quality photoreal motion: Veo 3 or Sora 2.
- For directorial control with creator-team workflow: Runway Gen-4.
- For long-form (over 30s) narrative: Kling 2.5 or 3.0.
- For high-volume test variants at lower cost: Seedance or Pika 2.x.
- For stylized cinematic mood: Hailuo.
- For image-to-video animation from existing stills: Pika 2.x.
- For fine-tuned brand-specific workflows: Hunyuan or Wan 2 with custom training.

A mature workflow uses multiple models, not one. Different jobs to different specialists.

The pricing reality: video generation is meaningfully more expensive than image generation. Per-clip costs range from $0.50 to $20+ depending on model, length, and resolution. Budget intentionally; do not generate at volume without a measurement plan to capture the value.

## Framework: use-case-to-model mapping

Different video use cases need different model capabilities. The mapping:

- **Product hero shot (15-30s, polished, brand surface).** Photoreal motion matters most. Recommend Veo 3 or Sora 2. Length usually 15-30s. Iteration cycles few but each iteration high-cost.
- **Social-first 9:16 (sub-15s, scroll-stopping).** Hook in 3 seconds, body in 5-8 seconds, CTA in last 2-3 seconds. Recommend Seedance or Pika 2.x for variant generation, Veo 3 or Sora 2 for finals. Volume matters; budget per clip is lower.
- **Animated explainer (30s-2min, instructional).** Character or product consistency across cuts matters most. Recommend Kling 2.5 / 3.0 for long-form coherence. Often hybrid with traditional motion graphics.
- **Lifestyle B-roll (variable length, mood-driven).** Aesthetic and motion quality matter most. Recommend Hailuo for stylized mood, Veo 3 for photoreal lifestyle.
- **Talking-head (variable length, narrator-driven).** Character consistency and lip-sync accuracy matter most. Recommend Sora 2 for photoreal character work, with awareness that current lip-sync is imperfect and may need post-production cleanup.
- **Packaging reveal or product-in-action (5-15s).** Often best generated as image-to-video from a still product photo. Recommend Pika 2.x.

The mapping is not exclusive; brands often use multiple models for different stages of a single campaign (hero from Veo 3, B-roll from Hailuo, variant tests from Seedance).

## Framework: prompt engineering for video

Video prompts have more structural complexity than image prompts because motion, time, and transitions are involved.

The prompt structure that works:

- **Opening frame.** Describe the starting image (subject, lighting, angle, surface, mood). Same discipline as image prompting.
- **Motion description.** What moves and how. "Camera dollies in slowly on the bottle" or "the model gently turns the bottle in their hand, label-side toward camera" or "wind rustles the leaves behind the product." Be specific about camera motion separately from subject motion.
- **Duration.** Explicit length in seconds. Most models default to 4-8 seconds; longer requires explicit specification and often costs more.
- **Camera motion language.** Use film-production vocabulary the model understands. "Static wide shot," "slow push-in," "dolly out," "tracking shot," "handheld shake (subtle)," "pan left to right." Vague motion produces unpredictable output.
- **Transitions (multi-clip).** If the video needs multiple shots, specify the transition style and the connecting subject (e.g. "match cut on the product going into the bag, then exterior city street shot").
- **Ending frame.** What the last frame shows. Critical because the brand often needs the last frame to land on the product or logo.
- **Style references.** Where supported, include image references for visual style. The brand's existing video stills can serve as references.

The negative prompt (where the model supports it): "no jump cuts, no oversaturated colors, no flickering, no anatomical errors, no logos other than brand." Reduces common failure modes.

The iteration loop: video iteration is slower than image iteration because each generation takes longer to render and review. Plan smaller batches (5-10 variants per iteration) and budget iteration cycles deliberately.

## Framework: character consistency across cuts

A major weakness of current video-generation models: characters do not stay consistent across cuts. A brand running an AI-generated narrative video with the same protagonist in multiple shots will often see slight (or major) character drift between cuts.

The techniques to maintain consistency:

- **Reference images.** Include the same character reference image in every cut's generation prompt. Reduces drift but does not eliminate.
- **Same-clip continuous shooting.** Generate the entire narrative as one long clip rather than as separate cuts, then edit it down in post. Avoids inter-clip character drift entirely.
- **Composite from image-to-video.** Generate a static character image, then animate it into multiple short clips using image-to-video models. The starting frame consistency carries forward.
- **Embrace the drift.** For experimental or stylized content, slight character drift can read as artistic variation. Not for hero campaigns where realism matters.
- **Hire a real human and film them.** For high-stakes content requiring consistent characters, AI is not yet the right tool. The decision criterion: does the consistency requirement exceed current model capability? If yes, film traditionally.

The discipline: scope the consistency requirement before committing to AI generation. Hero campaigns with strict character continuity are often better served by traditional production.

## Framework: AI video is a draft, edit it

Like AI images, AI video output is rarely production-ready. The post-production essentials:

- **Captions.** 80%+ of Meta and TikTok video plays muted. Captions are non-negotiable. Add them in post (CapCut, Premiere, similar) — most AI-generated video does not include captions natively.
- **Music.** Platform-licensed background music for TikTok / Reels, royalty-free or licensed track for paid placements. The music carries 30-40% of the emotional weight of short-form video.
- **Color grade.** Apply consistent color grading across all video assets in a campaign. AI-generated clips often have slightly different color tones from clip to clip; the grade unifies them.
- **Branded outro.** 2-3 second branded end card (logo, URL, primary CTA). The brand surface that ensures the viewer knows what the video was for. Often the difference between a video that performs and one that does not.
- **Sound design.** AI-generated video often has weak or no native audio. Add ambient sound, voiceover, or designed sound effects in post.
- **Trim and pacing.** AI clips often need trimming at the start and end for pacing. Cut the dead air; keep only the tight motion.

Brands that ship AI-generated video without post-production produce content that reads as AI and underperforms. Brands that invest in the post-production pipeline produce content that reads as cinematic with AI as a tool.

## Framework: platform-native discipline

The principles from ad-creative apply to AI-generated video as much as traditionally produced video:

- **TikTok-shape for TikTok.** Vertical 9:16, in-app feel, raw-looking, on-screen captions, on-trend audio, hand-held movement, creator face-forward (or product-forward) framing.
- **Meta Reels / Instagram.** Vertical 9:16 or square, slightly more polished, lifestyle context, lower text density.
- **Meta Feed.** Square or vertical, photo-quality or short-video, captions optional.
- **YouTube Shorts.** Vertical 9:16, audio-driven (sound on by default), longer hook tolerance.
- **YouTube pre-roll.** Horizontal or vertical depending on placement, audio-driven, longer story arc acceptable.

The mistake: generating a single video and repurposing across all platforms. A horizontal Veo 3 hero clip running on TikTok underperforms versus the same content reshot vertically.

The discipline: design the AI generation for the target platform first. Aspect ratio, length, and style all derive from the platform.

## Framework: the "creative testing budget" mindset

The core economic argument for AI video: it lets the brand test 20 variants for the cost of 1 traditional shoot. The argument is only valid if the brand has measurement infrastructure to learn from the variants.

The volume use case math:

- Traditional shoot: $5,000-$50,000 for a creative concept, single output, single iteration.
- AI generation: $50-$500 for 20 variants of the same concept, each iterated against a different hook, body, or CTA structure.

The measurement requirement: the brand must be able to attribute spend to creative variants and learn which variant won. Without this, the 20-variant advantage collapses into 20 unmeasured outputs.

The integration: connect to ad-creative for the hook-body-CTA isolation discipline, and to ab-testing for the test-design methodology. The brand should generate variants that isolate one creative variable (hook variation, CTA variation), not 20 variants that vary everything.

The "AI for testing, human for hero" pattern: many brands use AI generation for the volume-testing layer (cold-traffic variant generation) and traditional production for the hero campaigns. The AI variants identify winning structural patterns, which then inform the hero production. This pattern is the most common mature workflow in 2026.

## Framework: copyright and likeness landmines — sharper for video than for static

The copyright and likeness concerns from ai-image-generation apply, but sharper for video:

- **Derivative-work risk increases with motion.** A still that approximates a copyrighted image is a borderline case; a clip that approximates a copyrighted scene (camera angle, motion, character pose) is more clearly derivative.
- **Recognizable-individual risk increases with motion.** A still likeness can be ambiguous; a clip showing motion, mannerisms, and facial expressions of a recognizable individual is harder to defend as "incidental similarity."
- **Synthesized voices and lip-sync.** Some video models can include synthesized speech in matched lip-sync. Using a synthesized voice that resembles a recognizable individual is publicity-rights infringement.
- **Trademarked motion designs.** Some brands have trademarked specific motion designs (Apple's product reveal cadence, certain car-brand swoosh aesthetics). Approximating these in AI-generated video can trigger trademark issues.

The discipline:

- Do not generate video that synthesizes a recognizable individual's likeness or voice.
- Do not approximate a copyrighted scene's specific camera angle, motion design, or character pose.
- Maintain prompt logs for hero campaigns.
- Read the commercial-use terms for the specific model — they vary and shift.

The pragmatic stance: AI video for original product content in plausible environments is low risk. AI video that approximates known commercial film, advertising, or individual likenesses is higher risk and should be avoided for distributed marketing.

## Framework: human in the loop for hero campaigns, AI for testing

The mature pattern in 2026:

- **Hero campaigns.** Traditional production with strong human creative direction. AI may assist with pre-visualization, mood boards, and storyboard generation, but the final video is filmed traditionally. The reason: hero campaigns demand consistency, polish, and risk-management that current AI cannot reliably deliver.
- **Variant testing.** AI generation at volume. Hook variants, CTA variants, audience-segment-specific variants. The economic argument applies most strongly here.
- **Refresh and seasonal updates.** AI for quick refresh of evergreen content. Generate seasonal variants of a hero concept without re-shooting.

The brands that get value from AI video have a clear separation between hero (human) and testing (AI). Brands that try to use AI for everything produce inconsistent hero campaigns; brands that try to use traditional production for everything are out-competed on creative volume.

## Output Format

When asked for a generated-video plan, return:

1. **Use-case identification.** What is being generated and for what destination.
2. **Model recommendation.** Which model (or models) for the specific use case, with reasoning.
3. **Prompt design.** Specific prompt structure for the use case, including opening frame, motion description, duration, camera motion language, and ending frame.
4. **Character-consistency plan.** If the video requires character consistency across cuts, which technique to use.
5. **Post-production plan.** Captions, music, color grade, branded outro, sound design, pacing.
6. **Platform-native adjustment.** How the generation is shaped for the target platform.
7. **Testing budget.** Variant count, isolation discipline (one variable per test), measurement plan.

When asked for a model selection, return:

1. **Use case fit assessment.** Which model excels at the specific use case.
2. **Tradeoffs against alternatives.** What is sacrificed in the choice.
3. **Pricing and operational reality.** What the model costs and what infrastructure it requires.
4. **Iteration plan.** How to refine output toward production-readiness.

## Related Skills

- `ad-creative` — for the in-feed creative strategy that uses the generated video.
- `ai-image-generation` — for the static-image equivalent of this workflow.
- `social-strategy` — when the generated video is being designed for organic social channels.
- `ab-testing` — for the test-design methodology supporting variant testing.
- `copywriting` — for the captions, voiceover, and CTA copy within the video.
