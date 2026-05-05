#!/usr/bin/env python3
"""Terminal-based teaching agent for timestamped transcripts.

Usage (from this directory):

    python agent.py transcript.txt \
        --speed 1.0 \
        --model gpt-4o-mini \
        --commentary-style medium

The agent will:

1. Parse a transcript file where timestamps and text are interleaved, e.g.:

       0:01
       HANNA HAJISHIRZI: I am very excited to be here today...
       0:05
       in developing training recipes for building language models...

2. Ask you a few questions about your educational background and familiarity
   with the topic.

3. Replay the transcript in real time (adjustable speed) according to the
   timestamps, printing each chunk as it would occur in the talk.

4. After each segment, call the OpenAI API on a sliding window of recent
   transcript text together with your background. The model decides whether
   extra explanation would be useful for *you* at that moment. If so, it
   prints commentary and highlights the specific quoted phrases it is
   explaining.

Prerequisites
-------------
* Python 3.9+
* `pip install -r requirements.txt`
* Environment variable `OPENAI_API_KEY` set to a valid key.

Design notes
------------
* Transcript format: this script assumes lines containing timestamps such as
  "0:01", "12:34" or "1:02:03" alternate with one or more lines of spoken text.
* Playback timing: we treat timestamps as absolute seconds since the start of
  the talk and schedule each chunk based on the wall clock, scaled by
  `--speed`.
* Commentary: after each transcript segment is printed, we consult the OpenAI
  model with the user's background and the last ~90 seconds of transcript.
  The model decides whether extra explanation is needed *for this user* at
  this point. It responds in JSON with a `need_commentary` flag and a
  `commentary` field. Commentary can mark specific transcript phrases with
  `<<H>>...<</H>>` tags; these are rendered in color in the terminal.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from typing import List, Optional, Set

from dotenv import load_dotenv

try:
    # New OpenAI Python SDK (>=1.0)
    from openai import OpenAI
except ImportError:  # pragma: no cover - import-time guard
    OpenAI = None  # type: ignore


TIMESTAMP_PATTERN = re.compile(
    r"^\s*(?:(?P<hours>\d{1,2}):)?(?P<minutes>\d{1,2}):(?P<seconds>\d{2})\s*$"
)


@dataclass
class TranscriptSegment:
    """A contiguous span of transcript text starting at a given timestamp."""

    start_seconds: float
    raw_timestamp: str
    text: str


def parse_timestamp_to_seconds(ts: str) -> Optional[float]:
    """Parse timestamps like "0:01", "12:34", or "1:02:03" to seconds.

    Returns None if the string does not look like a timestamp.
    """

    m = TIMESTAMP_PATTERN.match(ts)
    if not m:
        return None

    hours = int(m.group("hours") or 0)
    minutes = int(m.group("minutes"))
    seconds = int(m.group("seconds"))
    return float(hours * 3600 + minutes * 60 + seconds)


def load_transcript(path: str) -> List[TranscriptSegment]:
    """Load and parse a timestamped transcript file.

    Heuristic parser: any line matching the timestamp pattern starts a new
    segment; subsequent non-empty lines are treated as that segment's text
    until the next timestamp line.
    """

    segments: List[TranscriptSegment] = []
    current_timestamp: Optional[str] = None
    current_start_seconds: Optional[float] = None
    current_lines: List[str] = []

    with open(path, "r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.rstrip("\n")
            ts_seconds = parse_timestamp_to_seconds(line)

            if ts_seconds is not None:
                # Flush previous segment, if any
                if (
                    current_timestamp is not None
                    and current_start_seconds is not None
                    and current_lines
                ):
                    segments.append(
                        TranscriptSegment(
                            start_seconds=current_start_seconds,
                            raw_timestamp=current_timestamp,
                            text=" ".join(current_lines).strip(),
                        )
                    )

                current_timestamp = line.strip()
                current_start_seconds = ts_seconds
                current_lines = []
            else:
                if line.strip():
                    current_lines.append(line.strip())

    # Flush last segment
    if (
        current_timestamp is not None
        and current_start_seconds is not None
        and current_lines
    ):
        segments.append(
            TranscriptSegment(
                start_seconds=current_start_seconds,
                raw_timestamp=current_timestamp,
                text=" ".join(current_lines).strip(),
            )
        )

    if not segments:
        raise ValueError(
            f"No transcript segments detected in {path!r}. "
            "Ensure it contains timestamps like '0:01' followed by text."
        )

    return segments


def collect_user_profile() -> str:
    """Interactively collect a brief, free-form description of the user.

    We intentionally keep this simple—just a few prompts concatenated into a
    single profile string passed into the model.
    """

    print("Let's customize the commentary to your background.\n")

    highest_education = input(
        "1) What is your highest level of education, experience, and field?\n> "
    ).strip()

    technical_background = input(
        "2) Briefly describe your technical background.\n> "
    ).strip()

    weak_topics = input(
        "3) Are there specific topics you feel weak on?\n> "
    ).strip()

    goals = input(
        "4) What is your main goal for this talk (e.g., high-level intuition, "
        "technical details, evaluating research claims)?\n> "
    ).strip()

    profile_parts = [
        f"Highest education and field: {highest_education or 'N/A'}",
        f"Technical background: {technical_background or 'N/A'}",
        f"Weaker topics: {weak_topics or 'N/A'}",
        f"Learning goals: {goals or 'N/A'}",
    ]

    profile = "\n".join(profile_parts)
    print("\nGreat, I will adapt explanations to this background as we go.\n")
    return profile


def build_excerpt(window_segments: List[TranscriptSegment], max_chars: int = 2000) -> str:
    """Build a textual excerpt from recent transcript segments.

    We include timestamps to help the model orient and to facilitate
    highlighting by quoting exact phrases.
    """

    lines: List[str] = []
    for seg in window_segments:
        lines.append(f"[{seg.raw_timestamp}] {seg.text}")

    full = "\n".join(lines)
    if len(full) <= max_chars:
        return full

    # Take the last max_chars to stay focused on the most recent content.
    return full[-max_chars:]


def colorize_highlights(text: str) -> str:
    """Render <<H>>...<</H>> spans in yellow for terminal highlighting."""

    def repl(match: re.Match[str]) -> str:
        inner = match.group(1)
        return f"\033[93m{inner}\033[0m"  # bright yellow

    return re.sub(r"<<H>>(.*?)<</H>>", repl, text, flags=re.DOTALL)


def extract_highlight_phrases(text: str) -> List[str]:
    """Extract phrases wrapped in <<H>>...<</H>> markers from commentary."""

    return [
        m.group(1)
        for m in re.finditer(r"<<H>>(.*?)<</H>>", text, flags=re.DOTALL)
    ]


def print_segment(seg: TranscriptSegment) -> None:
    """Print a transcript segment with its timestamp, nicely formatted."""

    print(f"\033[96m[{seg.raw_timestamp}]\033[0m {seg.text}")


def print_commentary(commentary: str, current_timestamp: str) -> None:
    """Print model-generated commentary with visual separation and highlights."""

    if not commentary.strip():
        return

    print("\n\033[95m=== Commentary (around " f"{current_timestamp}" ") ===\033[0m")
    print(colorize_highlights(commentary))
    print("\033[95m=== End Commentary ===\033[0m\n")


def get_openai_client() -> OpenAI:
    """Create an OpenAI client, ensuring the library is installed and a key set."""

    if OpenAI is None:
        raise RuntimeError(
            "The 'openai' package is not installed. Run 'pip install -r "
            "requirements.txt' before using this script."
        )

    # Load environment variables from a .env file if present (convenient for
    # local development). This is safe to call multiple times and is a no-op
    # if there is no .env file.
    load_dotenv()

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "OPENAI_API_KEY environment variable is not set. Please export it "
            "before running this script."
        )

    return OpenAI(api_key=api_key)


def generate_commentary(
    client: OpenAI,
    model: str,
    user_profile: str,
    window_segments: List[TranscriptSegment],
    commentary_style: str = "medium",
    explained_phrases: Optional[Set[str]] = None,
) -> Optional[str]:
    """Ask the OpenAI model whether commentary is needed and, if so, get it.

    The model is instructed to respond in JSON of the form:

        {
          "need_commentary": true/false,
          "commentary": "..."
        }

    where `commentary` may contain one or more spans of the form
    `<<H>>exact quoted phrase from the transcript<</H>>`.
    """

    excerpt = build_excerpt(window_segments)

    # Style-dependent instructions control how eager the assistant is to
    # intervene with commentary.
    if commentary_style == "low":
        style_instructions = (
            "- Be conservative: only set 'need_commentary' to true when there "
            "is direct, domain-specific technical jargon that requires a "
            "background that this user probably lacks. If the user can "
            "reasonably follow the material at a high-level, prefer 'need_commentary': false.\n"
        )
    elif commentary_style == "high":
        style_instructions = (
            "- Be proactive: whenever you see non-trivial technical content "
            "or important assumptions, set 'need_commentary' to true and add "
            "a brief explanation, even if the user might partially "
            "understand it already.\n"
        )
    else:  # "medium" (default)
        style_instructions = (
            "- Balance clarity and brevity: set 'need_commentary' to true "
            "when the excerpt introduces difficult domain-specific concepts that could "
            "reasonably confuse someone with this background, but skip "
            "commentary for very basic, intuitive, or already-explained points.\n"
        )

    system_prompt = (
        "You are a careful, concise AI teaching assistant helping a user follow "
        "a technical talk about open language models and reasoning. The user "
        "has provided their background. You see a recent excerpt of the "
        "transcript and must decide whether they are likely to have knowledge "
        "gaps, and if so, explain the material in a way tailored to them.\n\n"
        "CRITICAL REQUIREMENTS:\n"
        "- Respond in STRICT JSON so it can be parsed by a program.\n"
        "- The JSON must have keys 'need_commentary' (boolean) and "
        "'commentary' (string).\n"
        "- If no additional explanation is needed, set 'need_commentary' to "
        "false and 'commentary' to an empty string.\n"
        "- If explanation is needed, set 'need_commentary' to true and write "
        "a short, focused explanation in 'commentary'.\n"
        "- In the commentary, directly quote 1-3 short phrases from the "
        "transcript that you are explaining, and wrap EACH quoted phrase in "
        "<<H>> and <</H>> markers, for example:\n"
        "  <<H>>pretraining data<</H>> is the large corpus...\n"
        "- Keep commentary concrete and example-driven; avoid repeating large "
        "chunks of the transcript.\n" +
        style_instructions
    )

    # Include a summary of topics/phrases that have already been explained so
    # the model can avoid repeating itself.
    explained_section = ""
    if explained_phrases:
        explained_lines = "\n".join(
            f"- {phrase}" for phrase in sorted(explained_phrases)
        )
        explained_section = (
            "Topics/phrases already explained earlier in this talk. Do not "
            "re-explain these unless offering a very brief new angle that is "
            "clearly different from what was said before:\n" +
            explained_lines + "\n\n"
        )

    user_prompt = (
        "User background:\n" + user_profile + "\n\n" +
        explained_section +
        "Recent transcript excerpt (chronological, oldest first):\n" + excerpt
    )

    # Using Chat Completions API via new SDK
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.4,
        max_tokens=400,
    )

    content = response.choices[0].message.content or ""

    # Try to parse JSON; if that fails, fall back to using the raw content.
    try:
        data = json.loads(content)
        if isinstance(data, dict):
            need = bool(data.get("need_commentary", False))
            comm = str(data.get("commentary", ""))
            if not need or not comm.strip():
                return None
            return comm.strip()
    except json.JSONDecodeError:
        # Fall back to heuristic: treat non-empty content as commentary.
        if content.strip():
            return content.strip()

    return None


def run_playback(
    segments: List[TranscriptSegment],
    client: OpenAI,
    model: str,
    user_profile: str,
    speed: float,
    commentary_style: str = "medium",
    context_window_seconds: float = 90.0,
) -> None:
    """Replay the transcript in (scaled) real time with model-driven commentary.

    After each segment is printed, the model is consulted on whether
    commentary is needed, based on the user's background and recent context.
    """

    if speed <= 0:
        raise ValueError("Playback speed must be positive.")

    first_start = segments[0].start_seconds
    playback_start_wall = time.time() - (first_start / speed)
    window_segments: List[TranscriptSegment] = []
    # Track which phrases (as marked by <<H>>...<</H>>) have already been
    # explained, to avoid repetitive commentary.
    explained_phrases: Set[str] = set()

    print(f"\nStarting playback with speed={speed}x.\n")

    for seg in segments:
        # Schedule based on timestamp and speed
        target_wall = playback_start_wall + (seg.start_seconds / speed)
        now = time.time()
        sleep_dur = target_wall - now
        if sleep_dur > 0:
            time.sleep(sleep_dur)

        print_segment(seg)

        # Update sliding window of recent segments
        window_segments.append(seg)
        window_start_cutoff = seg.start_seconds - context_window_seconds
        window_segments = [
            s for s in window_segments if s.start_seconds >= window_start_cutoff
        ]

        try:
            commentary = generate_commentary(
                client=client,
                model=model,
                user_profile=user_profile,
                window_segments=window_segments,
                commentary_style=commentary_style,
                explained_phrases=explained_phrases,
            )
        except Exception as e:  # pragma: no cover - runtime API failures
            print(
                f"\n[Warning] Failed to generate commentary at "
                f"{seg.raw_timestamp}: {e}\n",
                file=sys.stderr,
            )
            continue

        if commentary:
            # Check which phrases this commentary is actually highlighting.
            new_phrases = [
                p.strip() for p in extract_highlight_phrases(commentary) if p.strip()
            ]

            # If all highlighted phrases have been explained before, we can
            # safely skip printing this commentary to reduce repetition.
            if new_phrases and all(p in explained_phrases for p in new_phrases):
                continue

            print_commentary(commentary, current_timestamp=seg.raw_timestamp)

            # Update the global set with any newly highlighted phrases so the
            # model prompt (and the filter above) can avoid repeating them.
            explained_phrases.update(new_phrases)


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Replay a timestamped transcript in real time and generate "
            "personalized commentary using the OpenAI API."
        )
    )

    parser.add_argument(
        "transcript_path",
        help="Path to the transcript file (e.g., transcript.txt)",
    )

    parser.add_argument(
        "--speed",
        type=float,
        default=1.0,
        help=(
            "Playback speed multiplier (e.g., 1.0 = real time, 1.5 = 1.5x, "
            "0.5 = half speed)."
        ),
    )

    parser.add_argument(
        "--model",
        default="gpt-4o-mini",
        help=(
            "OpenAI model name to use for commentary generation "
            "(default: gpt-4o-mini)."
        ),
    )

    parser.add_argument(
        "--commentary-style",
        choices=["low", "medium", "high"],
        default="medium",
        help=(
            "How often the assistant should speak up: 'low' = only when "
            "things are likely confusing, 'medium' = balanced (default), "
            "'high' = very proactive commentary."
        ),
    )

    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> None:
    args = parse_args(argv)

    try:
        segments = load_transcript(args.transcript_path)
    except Exception as e:
        print(f"Error loading transcript: {e}", file=sys.stderr)
        sys.exit(1)

    user_profile = collect_user_profile()

    try:
        client = get_openai_client()
    except Exception as e:
        print(f"Error initializing OpenAI client: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        run_playback(
            segments=segments,
            client=client,
            model=args.model,
            user_profile=user_profile,
            speed=args.speed,
            commentary_style=args.commentary_style,
        )
    except KeyboardInterrupt:
        print("\nPlayback interrupted by user.")
    except Exception as e:
        print(f"Unexpected error during playback: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    main()
