"""Sorts a stream into politics, entertainment or gaming (and which game).

The input is what Twitch shows on the page: the stream's category, title and tags.
Twitch categories are games unless they are one of its non-game sections.
A stream in a chat category whose title or tags are about politics counts as politics.
"""

from __future__ import annotations

import re

POLITICS, ENTERTAINMENT, GAMING = "politics", "entertainment", "gaming"
GROUPS = (POLITICS, ENTERTAINMENT, GAMING)

NON_GAME = {
    "politics": POLITICS,
    "just chatting": ENTERTAINMENT,
    "talk shows & podcasts": ENTERTAINMENT,
    "irl": ENTERTAINMENT,
    "music": ENTERTAINMENT,
    "art": ENTERTAINMENT,
    "asmr": ENTERTAINMENT,
    "travel & outdoors": ENTERTAINMENT,
    "food & drink": ENTERTAINMENT,
    "special events": ENTERTAINMENT,
    "sports": ENTERTAINMENT,
    "pools, hot tubs, and beaches": ENTERTAINMENT,
    "makers & crafting": ENTERTAINMENT,
    "science & technology": ENTERTAINMENT,
    "software and game development": ENTERTAINMENT,
    "beauty & body art": ENTERTAINMENT,
    "fitness & health": ENTERTAINMENT,
    "animals, aquariums, and zoos": ENTERTAINMENT,
    "co-working & studying": ENTERTAINMENT,
    "writing & reading": ENTERTAINMENT,
    "dj": ENTERTAINMENT,
    "fashion": ENTERTAINMENT,
    "movies & tv": ENTERTAINMENT,
    "watch party": ENTERTAINMENT,
    "news": POLITICS,
}

POLITICAL = re.compile(
    r"\b(?:politic\w*|election\w*|debates?|congress|senat\w*|parliament\w*|president\w*|white house|"
    r"midterms?|primar(?:y|ies)|democrat\w*|republican\w*|gop|liberal\w*|conservative\w*|leftis\w*|right[- ]wing|left[- ]wing|"
    r"government\w*|policy|policies|ballot\w*|vot(?:e|es|ing|ers?)|supreme court|immigration|tariffs?|"
    r"trump|biden|harris|vance|obama|musk|gaza|israel\w*|palestin\w*|ukrain\w*|russia\w*|iran\w*|nato|"
    r"geopolitic\w*|war|news|breaking)\b",
    re.IGNORECASE,
)

FAMILIES = [
    (r"^call of duty", "Call of Duty"),
    (r"^(?:counter-strike|cs:?go|cs2)\b", "Counter-Strike"),
    (r"^grand theft auto", "Grand Theft Auto"),
    (r"^minecraft", "Minecraft"),
    (r"^fortnite", "Fortnite"),
    (r"^league of legends", "League of Legends"),
    (r"^valorant", "VALORANT"),
    (r"^apex legends", "Apex Legends"),
    (r"^(?:ea sports fc|fifa)", "EA SPORTS FC"),
    (r"^overwatch", "Overwatch"),
    (r"^world of warcraft", "World of Warcraft"),
    (r"^dota", "Dota 2"),
    (r"^(?:tom clancy's )?rainbow six", "Rainbow Six Siege"),
    (r"^battlefield", "Battlefield"),
    (r"^escape from tarkov", "Escape from Tarkov"),
    (r"^rocket league", "Rocket League"),
    (r"^pubg|^playerunknown", "PUBG"),
    (r"^the sims", "The Sims"),
    (r"^pok[eé]mon", "Pokémon"),
    (r"^elden ring", "Elden Ring"),
]
FAMILIES = [(re.compile(p, re.IGNORECASE), name) for p, name in FAMILIES]


def game_family(category: str) -> str:
    for regex, name in FAMILIES:
        if regex.search(category):
            return name
    return category


def classify(category: str | None, title: str | None = None, tags: list[str] | None = None) -> tuple[str, str | None]:
    """→ (group, game). `game` is set only for gaming streams."""
    category = (category or "").strip()
    key = category.lower()
    if not category:
        text = " ".join([title or "", *(tags or [])])
        return (POLITICS if len(POLITICAL.findall(text)) >= 2 else ENTERTAINMENT), None
    if key in NON_GAME:
        group = NON_GAME[key]
        if group == ENTERTAINMENT:
            in_tags = any(POLITICAL.search(t) for t in tags or [])
            in_title = len(set(m.lower() for m in POLITICAL.findall(title or "")))
            if in_tags or in_title >= 2:
                group = POLITICS
        return group, None
    return GAMING, game_family(category)
