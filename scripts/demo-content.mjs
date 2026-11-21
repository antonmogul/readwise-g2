// Demo library for screenshots and videos (`DEMO=1 npm run standin`).
//
// Every article, publication and author here is invented for the demo, so no
// real outlet is credited with words it never published. The prose is real
// prose, though: the reader's sheets, the progress bar and the summaries are
// only convincing on text that reads like an article.

const p = (...paras) => paras.map((t) => `<p>${t}</p>`).join('\n');

export const DEMO_LIBRARY = [
  {
    id: 'd1',
    title: 'The quiet case for reading less, but finishing more',
    site: 'Field Notes', author: 'Mara Ellison', mins: 8, progress: 0, location: 'new',
    blurb: 'A saved-for-later list is a promise to your future self. Most of us break it daily.',
    summary: [
      'Ellison argues that the problem with read-it-later apps is not too little time but too many open loops: every unread save is a small promise, and a list of four hundred of them reads as a debt rather than a library.',
      'Her fix is deliberately unglamorous. Decide quickly, finish what you start, and archive without guilt. She tracked a year of her own saves and found that articles opened within two days were finished three times as often as anything older.',
      'The conclusion is that a reading tool should make the decision cheap, not the hoarding easy — a summary to judge by, one gesture to archive, and a clear place to pick up what is half done.',
    ].join('\n\n'),
    html: p(
      'Every read-it-later list begins as an act of optimism. You see something worth your attention, you are busy, and you make a small promise to the person you will be on Sunday afternoon. Multiply that by a few years and the list stops being a library. It becomes a ledger of promises you did not keep.',
      'I know this because I kept the ledger. For twelve months I logged every article I saved, when I opened it, and whether I reached the end. The numbers were not flattering. I saved a little over nine hundred pieces and finished two hundred and eleven of them.',
      'The striking pattern was not how much I failed to read but when. Articles I opened within two days of saving were finished three times as often as anything older. After a fortnight, the chance that I would ever finish a piece fell close to zero. The list was not a queue. It was a slow archive with extra steps.',
      'So I changed the rules. Every morning I look at what arrived and make one decision per item: read it now, read it this week, or let it go. Letting go is the important one. Archiving something unread is not a failure of curiosity; it is an honest answer to a question I had been avoiding.',
      'The second rule is to finish what I start. If an article earns the first few screens, it earns the rest, and if it does not, I archive it there and then rather than leaving it half read to haunt the Continue list.',
      'None of this needs discipline so much as the right defaults. A reading tool should make the decision cheap: a short summary to judge by, a single gesture to archive, and a clear place to pick up what is half done. Hoarding is already easy. Deciding is what deserves the help.',
      'A year later my list is shorter, my reading is longer, and the Sunday-afternoon version of me finally has a reasonable amount of homework.',
    ),
  },
  {
    id: 'd2',
    title: 'Why every city is suddenly redesigning its kerbs',
    site: 'Harbour Review', author: 'Tom Okafor', mins: 12, progress: 0, location: 'later',
    blurb: 'Delivery vans, scooters and buses all want the same three metres of road edge.',
    summary: [
      'Okafor shows how the kerb — the last few metres of road before the pavement — has become the most contested space in cities, fought over by delivery vans, ride-hail pick-ups, buses, bikes and parking.',
      'Cities that treat it as a managed, priced resource, with loading windows and dynamic zones, report shorter double-parking queues and faster buses. Those that leave it as free parking get gridlock by another name.',
      'His point is that kerb policy is now transport policy, and the cities moving fastest are the ones counting who actually uses each metre.',
    ].join('\n\n'),
    html: p(
      'Stand on almost any high street at eleven in the morning and count what stops at the kerb. A parcel van, two ride-hail cars, a bus that cannot reach its stop, a scooter rider, a delivery cyclist and a resident looking for a space. All of them want the same three metres of road edge, and most of them get it by blocking a lane.',
      'For most of the last century the kerb had one job: parking. Cities priced it cheaply or not at all, and the rest of the street flowed around it. That arrangement quietly broke when online shopping turned every residential road into a loading bay.',
      'The cities now redesigning their kerbs are doing something unglamorous first. They are counting. Sensors and simple surveys show who stops, for how long and when, and the results are usually a surprise: a handful of delivery windows account for most of the double parking.',
      'With that data in hand, the fixes are modest. Loading zones that become parking in the evening. Bus stops lengthened by a single car length. Paid short stays for pick-ups, so that a two-minute stop no longer competes with an all-day car.',
      'The early results are encouraging. Districts that treat the kerb as a managed resource report shorter queues behind stopped vans and buses that keep to their timetable more often. Districts that leave it as free parking simply move the gridlock somewhere else.',
      'The lesson is that kerb policy has become transport policy. The road edge is where every new kind of mobility touches the city, and the places moving fastest are the ones that stopped treating it as a parking strip.',
    ),
  },
  {
    id: 'd3',
    title: 'What a pocket calculator teaches about interface design',
    site: 'Small Systems', author: 'Priya Natarajan', mins: 6, progress: 0, location: 'new',
    blurb: 'Eight digits, a few keys and no menus. Why the constraints made it good.',
    summary: [
      'Natarajan uses the 1970s pocket calculator as a case study in designing for a tiny display: eight digits, no menus, and every key doing one obvious thing.',
      'The constraints forced clarity. With no room for explanation, the device had to make its state visible at a glance and its next action predictable.',
      'She argues the same discipline applies to watches and smart glasses today — design for a glance, keep one action per gesture, and treat every pixel as a decision.',
    ].join('\n\n'),
    html: p(
      'The pocket calculators of the 1970s had less screen than a modern notification and fewer controls than a microwave. They were also among the most usable machines ever sold.',
      'Their displays showed eight digits and nothing else. There were no menus to get lost in and no settings to misconfigure. Every key did one obvious thing, and the result of pressing it appeared immediately where you were already looking.',
      'Those constraints were not chosen for elegance. Segment displays were expensive and memory was scarce. But the effect was a design that could be understood at a glance, which is exactly what small screens still demand.',
      'Today the same problem has moved to watches and smart glasses. A glanceable display cannot explain itself. It has to make its state visible, keep the next action predictable, and stay out of the way the rest of the time.',
      'The discipline is the same as it was fifty years ago: one action per gesture, nothing on screen that does not need to be there, and every pixel treated as a decision.',
    ),
  },
  {
    id: 'd4',
    title: 'The long afternoon of the four-day week',
    site: 'Northwind Weekly', author: 'Elena Brandt', mins: 15, progress: 0.34, location: 'later',
    blurb: 'Two years into the trial, the companies that kept it changed more than the calendar.',
    summary: [
      'Brandt revisits companies two years into a four-day-week trial and finds that the fifth day was never the hard part — fitting the work into four was.',
      'The firms that kept the schedule used it as an audit: fewer meetings, more writing, and managers measuring output instead of presence. The ones that dropped it had compressed the hours without changing the work.',
      'Her conclusion is that what lasts is the habit, not the day off — asking what a meeting is for, and writing things down so fewer are needed.',
    ].join('\n\n'),
    html: p(
      'When the trial began, most of the participating companies expected the fifth day to be the hard part. It turned out to be the other four.',
      'Fitting five days of work into four meant deciding what the work actually was. Meetings shrank or vanished. Status updates moved into writing. Managers who had measured effort by presence had to find something better to measure.',
      'Two years on, the companies that kept the schedule describe the change less as a perk and more as an audit. The calendar forced the question, and the answers stuck even where the Friday did not.',
      'The companies that dropped it share a pattern too. They compressed the hours without changing the work, and the long afternoons that followed were long in every sense.',
      'What survives, in the end, is not a day off but a habit: asking what a meeting is for before booking it, and writing things down so that fewer of them are needed.',
    ),
  },
  {
    id: 'd5',
    title: 'A year of reading on a heads-up display',
    site: 'The Signal', author: 'Sam Reyes', mins: 9, progress: 0.62, location: 'later',
    blurb: 'Glanceable text turned out to be better for some reading than any screen in a pocket.',
    summary: [
      'Reyes expected smart glasses to be useless for long reading and found the opposite: glances added up to more reading in a year than his phone ever managed.',
      'Two things made it work. The glasses offered nothing else to do, and the reader always remembered his place, so a few paragraphs at a time never meant losing the thread.',
      'Archiving with one gesture kept the list honest — finished pieces simply disappeared.',
    ].join('\n\n'),
    html: p(
      'I did not expect to read long articles on glasses. The display is small, the text is green, and the whole point of the device seemed to be glances.',
      'But glances add up. A few paragraphs while the kettle boils, a page on the walk to the station, the end of an argument while waiting for a meeting to start. Over a year it came to more reading than my phone ever managed, mostly because the glasses never offered me anything else to do.',
      'The trick, I found, was that the reader remembered where I was. I never had to find my place, and the archive gesture meant finished pieces simply disappeared from the list.',
    ),
  },
  {
    id: 'd6',
    title: 'How bakeries got good at forecasting',
    site: 'Field Notes', author: 'Jon Avery', mins: 5, progress: 0, location: 'later',
    blurb: 'Yesterday’s bread is a forecasting error you can hold in your hand.',
    summary: [
      'Avery looks at how small bakery chains learned to forecast demand, where every error is visible — sold out by noon, or racks of unsold loaves at closing.',
      'The good ones skipped elaborate software and kept a notebook of weather, school holidays, local fixtures and sales. Within a year the notebook knew more than anyone behind the counter.',
    ].join('\n\n'),
    html: p(
      'A bakery that sells out by noon has under-forecast, and one with racks of loaves at closing time has over-forecast. Either way, the error is visible to every customer.',
      'The small chains that have got good at this did not buy elaborate software. They kept a notebook: weather, school holidays, the football fixtures, and what sold. After a year the notebook knew more than anyone behind the counter.',
    ),
  },
];

export const DEMO_FEED = [
  ['Battery makers race to a cheaper sodium cell', 'Charge Weekly'],
  ['The case for boring infrastructure', 'Harbour Review'],
  ['A new map of the world’s busiest shipping lanes', 'Northwind Weekly'],
  ['Why your phone’s camera keeps getting heavier', 'Small Systems'],
  ['Three cities try free buses — the early numbers', 'Harbour Review'],
  ['Inside the race to make heat pumps quieter', 'Charge Weekly'],
  ['The surprising return of the paper notebook', 'Field Notes'],
  ['Satellite internet comes to the canal boats', 'The Signal'],
  ['What we learned from a week without notifications', 'The Signal'],
  ['A short history of the shipping container', 'Northwind Weekly'],
].map(([title, site], i) => ({ id: `f${i}`, title, site }));

/** Feed triage as a model would return it — themes, not publications. */
export const DEMO_TRIAGE = {
  sections: [
    { name: 'Energy, getting cheaper', note: 'Batteries and heat pumps both turning a corner', ids: ['f0', 'f5'] },
    { name: 'How cities move', note: 'Free buses and the case for dull upgrades', ids: ['f4', 'f1'] },
    { name: 'Calmer tech', note: 'Notebooks and fewer notifications', ids: ['f6', 'f8'] },
  ],
};
