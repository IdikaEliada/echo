# Find nearby

EchoBot finds the nearest barber, food spot, printer, laundry, tailor and more. It gives one top pick plus a few alternatives, with hours, phone, a map pin, landmark-based walking directions and an "open in Google Maps" link. It works on the web app (Find nearby tab), Telegram (`/find`, or just ask) and the CLI (`/find`).

## What memory does

Everything lives on Walrus Memory, so it carries across web, Telegram and CLI once you `/link`:

| Memory | Namespace | Used for |
| --- | --- | --- |
| Saved spots ("Hostel B") | `…-finder` | "food near Hostel B" works anywhere; default search area |
| Places you passed on, and why | `…-finder` | Ranked lower next time ("Skipped Kings Cut: too far") |
| Your visit ratings | `…-finder` | Places you liked rise, places you rated badly drop |
| Everyone's visit ratings | `…-community-ratings` | "4.6★ on EchoBot (12 visits)", shown as "New" until 3 ratings; one vote per person |
| Your last search | `…-settings` | "Not this one" works on any server instance or channel |
| Facts about you | `…-facts` | e.g. "I'm vegetarian" or "I'm on a budget" shapes the search |

Each answer says what memory changed ("What I remembered"), so the before/after is visible.

## Where places come from

1. **EchoBot's own list**, `src/data/places.json`: places checked in person. These rank higher and can carry phone numbers, landmark notes and last-mile hints that maps miss.
2. **OpenStreetMap** through the Overpass API: free, open data.

Nothing is invented. A place appears only if it is in one of these sources. Directions are built from the routing engine's real steps, with landmarks taken from the same two sources. No LLM writes the directions, so it can't make up a turn or a landmark. The LLM only turns the request into a structured search (category, open now, keywords, place). If it fails, keyword matching takes over.

## Adding verified places

Add entries to `src/data/places.json`:

```json
{
  "places": [
    {
      "id": "eb:kings-cut",
      "name": "Kings Cut Barbers",
      "category": "barber",
      "lat": 6.8671,
      "lng": 7.4121,
      "phone": "+234 803 000 0000",
      "hours": "Mo-Sa 08:00-21:00; Su 13:00-20:00",
      "landmark": "opposite GTBank, green gate",
      "lastMile": "second shop after the pharmacy",
      "keywords": ["fade", "locs", "beard"],
      "verified": "2026-10-07"
    }
  ],
  "landmarks": [
    { "name": "Main Gate", "lat": 6.866, "lng": 7.411, "aliases": ["school gate", "front gate"] }
  ]
}
```

- `category` is one of the ids in `src/lib/find/categories.ts` (barber, salon, food, cafe, printing, laundry, tailor, pharmacy, clinic, atm, supermarket, phone, fuel, market, hotel, worship, bar, transport).
- `hours` uses the OpenStreetMap `opening_hours` format. Leave it out if you don't know them.
- `landmarks` are what people type ("near the main gate"). They also show up in directions.
- Take the pin with your phone outside the entrance. Indoors, GPS can be 30 m or more off.

## Not built yet (from the FindMe spec)

Business submissions and admin review, live "is it open?" calls, campus footpaths, voice-note search on the web, and fare estimates.
