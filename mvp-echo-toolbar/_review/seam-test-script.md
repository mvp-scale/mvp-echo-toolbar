# Seam test script

**Why this exists:** chunking splits audio into 30-second windows and merges the results. If the
merge drops or duplicates text at a boundary, free-form speech hides it — you can't tell a merge
error from your own repetition. Every sentence below is numbered and distinct, so any drop or
duplicate is visible by checking the number sequence.

## How to run it

1. Start recording (Ctrl+Alt+Z), wait for the tone.
2. Read the lines below at a normal pace. **Say the number**, then the sentence.
3. Brief pause between lines — a natural breath is enough.
4. Stop recording after the last line.
5. Paste the `Result: "..."` line back.

Aim for ~3 seconds per line. Forty-eight lines ≈ 2.5–3 minutes, which crosses **five or six**
window boundaries.

## What we check

- **All 48 numbers present**, in order, exactly once
- **No sentence appears twice** (duplication at a seam)
- **No sentence missing** (dropped at a seam)
- Numbers near multiples of 30 seconds matter most — that's where seams land

Don't worry about perfect diction. Misheard *words* are fine; missing or doubled *numbers* are not.

---

## The script

1. The harbor lights flickered against the evening fog.
2. Copper wire conducts electricity better than steel.
3. She planted seventeen tulip bulbs before the frost arrived.
4. The mountain trail switches back eleven times.
5. Fresh bread cools faster on a wire rack.
6. Antarctic ice cores preserve air from ancient centuries.
7. The violin needed new strings before the concert.
8. Migrating geese navigate using magnetic fields.
9. He rebuilt the carburetor with parts from a scrapyard.
10. Saltwater corrodes aluminum surprisingly quickly.
11. The library basement holds newspapers from 1904.
12. Sourdough starter needs feeding every single morning.
13. Lightning strikes the same tower repeatedly.
14. The cartographer marked three unnamed islands.
15. Bamboo grows nearly a meter in a single day.
16. Her telescope resolved the rings of Saturn clearly.
17. The bridge expands four inches in summer heat.
18. Wool retains warmth even when thoroughly soaked.
19. The clockmaker apprenticed for nine long years.
20. Desert foxes hunt primarily after sunset.
21. Concrete continues curing for decades after pouring.
22. The manuscript was written entirely in green ink.
23. Honeybees communicate direction through dancing.
24. Glacial meltwater runs a striking milky blue.
25. The lighthouse keeper logged every passing vessel.
26. Cast iron pans improve with consistent use.
27. Redwood bark resists fire remarkably well.
28. The observatory closes whenever winds exceed forty knots.
29. Fermentation converts sugar into alcohol and gas.
30. She translated the poem into four languages.
31. Tidal patterns follow the lunar cycle precisely.
32. The engine block cracked during the cold snap.
33. Origami requires no cutting and no glue.
34. Volcanic soil produces exceptional coffee beans.
35. The archivist wore cotton gloves at all times.
36. Sound travels faster through water than air.
37. His workshop smelled of cedar and machine oil.
38. Compass needles drift near iron ore deposits.
39. The quilt used fabric from six generations.
40. Mushrooms fruit after warm autumn rainfall.
41. She calibrated the scale to a tenth of a gram.
42. Suspension bridges sway by careful design.
43. The kiln reached twelve hundred degrees overnight.
44. Arctic terns migrate pole to pole annually.
45. He sharpened the chisel on a waterstone.
46. Limestone caves form over countless millennia.
47. The telegraph line crossed the continent in 1861.
48. Every ledger balanced perfectly at the year's end.
