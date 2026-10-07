// The fixed category list. Search always maps a request onto one of these so
// results are consistent, and each one knows which OpenStreetMap tags to ask for.

export type Category = {
  id: string;
  label: string;
  /** Words people actually type for this category (Nigerian English included). */
  words: string[];
  /** OpenStreetMap key/value pairs, as `key=v1|v2`. */
  osm: string[];
};

export const CATEGORIES: Category[] = [
  { id: "barber", label: "Barber", words: ["barber", "haircut", "hair cut", "barbing", "barbing salon", "fade", "lowcut", "low cut", "shave"], osm: ["shop=hairdresser"] },
  { id: "salon", label: "Hair & beauty salon", words: ["salon", "hair salon", "braids", "braiding", "locs", "nails", "makeup", "beauty", "lashes"], osm: ["shop=hairdresser|beauty|cosmetics"] },
  { id: "food", label: "Food", words: ["food", "eat", "restaurant", "canteen", "buka", "mama put", "chop", "jollof", "rice", "amala", "suya", "shawarma", "chicken", "lunch", "dinner", "breakfast", "hungry"], osm: ["amenity=restaurant|fast_food|food_court"] },
  { id: "cafe", label: "Cafe", words: ["cafe", "coffee", "tea", "snacks", "pastries", "bakery", "bread"], osm: ["amenity=cafe", "shop=bakery"] },
  { id: "printing", label: "Printing & photocopy", words: ["print", "printing", "photocopy", "photocopying", "copy", "scan", "scanning", "binding", "laminate", "lamination", "passport photo", "passport photos", "business centre", "business center", "cyber cafe"], osm: ["shop=copyshop|stationery|photo", "craft=printer", "amenity=internet_cafe"] },
  { id: "laundry", label: "Laundry", words: ["laundry", "dry clean", "dry cleaning", "dry cleaner", "wash clothes", "washing", "iron"], osm: ["shop=laundry|dry_cleaning"] },
  { id: "tailor", label: "Tailor", words: ["tailor", "sew", "sewing", "fashion designer", "alteration", "adjust my", "native", "agbada"], osm: ["craft=tailor|dressmaker", "shop=tailor|fabric"] },
  { id: "pharmacy", label: "Pharmacy", words: ["pharmacy", "chemist", "drugs", "medicine", "drug store", "pharmacist"], osm: ["amenity=pharmacy", "shop=chemist"] },
  { id: "clinic", label: "Clinic & hospital", words: ["hospital", "clinic", "doctor", "health centre", "health center", "medical centre", "emergency"], osm: ["amenity=hospital|clinic|doctors"] },
  { id: "atm", label: "ATM & bank", words: ["atm", "bank", "cash", "withdraw", "pos", "transfer"], osm: ["amenity=atm|bank|bureau_de_change"] },
  { id: "supermarket", label: "Supermarket & shop", words: ["supermarket", "shop", "provisions", "groceries", "store", "mart", "kiosk", "buy"], osm: ["shop=supermarket|convenience|general|kiosk"] },
  { id: "phone", label: "Phone & gadget repair", words: ["phone repair", "screen", "charger", "gadget", "laptop repair", "phone", "airtime", "data", "recharge card", "sim"], osm: ["shop=mobile_phone|electronics|computer", "craft=electronics_repair"] },
  { id: "fuel", label: "Fuel station", words: ["fuel", "petrol", "filling station", "gas station", "diesel", "gas"], osm: ["amenity=fuel"] },
  { id: "market", label: "Market", words: ["market"], osm: ["amenity=marketplace"] },
  { id: "hotel", label: "Hotel & lodge", words: ["hotel", "lodge", "guest house", "guesthouse", "room for the night"], osm: ["tourism=hotel|guest_house|hostel|motel"] },
  { id: "worship", label: "Place of worship", words: ["church", "mosque", "chapel", "worship", "mass", "service", "jumat"], osm: ["amenity=place_of_worship"] },
  { id: "bar", label: "Bar & lounge", words: ["bar", "lounge", "drinks", "beer", "club", "joint", "relaxation spot"], osm: ["amenity=bar|pub|nightclub"] },
  { id: "transport", label: "Bus & keke park", words: ["bus stop", "park", "motor park", "keke", "okada", "bus", "taxi", "transport"], osm: ["amenity=bus_station|taxi", "highway=bus_stop"] },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

export function categoryById(id: string | null | undefined): Category | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

/** Best keyword match, longest phrase first so "passport photo" beats "photo". */
export function guessCategory(text: string): Category | undefined {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ")} `;
  let best: { cat: Category; len: number } | undefined;
  for (const cat of CATEGORIES) {
    for (const w of cat.words) {
      if (t.includes(` ${w} `) || t.includes(` ${w}s `)) {
        if (!best || w.length > best.len) best = { cat, len: w.length };
      }
    }
  }
  return best?.cat;
}
