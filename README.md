# Bridging Knowledge Gaps in Live Seminars with Faro, a Personalized AI Learning Copilot
_Award Winning Project: 2nd Place & Audience Choice Award ($1000), 2026 UCSF AI Education Hackathon (40+ submissions)_

## Abstract
Faro addresses a common educational problem in graduate training: interdisciplinary seminars are plentiful, but comprehension is uneven because speakers assume a background that many listeners do not share. Important ideas slip by when a prerequisite concept is missing, and the listener cannot pause the room to catch up. Curiosity gets punished by speed, and cross-field motivation is quietly reduced even in an institution that does an exceptional job convening experts.

Faro is a real-time AI seminar copilot that adapts dense material to each attendee’s unique background and level of understanding. It listens and transcribes in real time, identifies likely knowledge gaps using a dynamic learner profile, and surfaces concise, optional explanations in the moment. Built on UCSF Versa for LLM-based reasoning, Faro generates time-aligned transcripts and grounded clarifications from live or recorded audio. After the talk, it delivers a personalized summary, concept map, and targeted review so listeners leave with a coherent mental model rather than scattered highlights.

## How to Use

Run flask app: `python flask_app.py`

Run terminal demo: `python agent.py transcript.txt --speed 1.0 --model gpt-4o-mini --commentary-style low`
