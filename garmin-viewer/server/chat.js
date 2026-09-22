// Backs the "Coach" tab: a chat interface for asking training/health
// questions, grounded in the athlete's own real data (recent wellness,
// activities, body composition, scorecard) rather than answering blind.
// Reuses the same fetch-Claude-directly pattern as briefing.js, extended
// with tool use so the coach can remember durable facts the athlete
// mentions in conversation (upcoming trips/objectives, standing equipment
// or schedule facts) -- see server/contextNotes.js for where those land.

const contextNotes = require('./contextNotes');

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const MAX_HISTORY_MESSAGES = 16; // keep the request small; the UI keeps the full transcript client-side
const MAX_TOOL_ROUNDS = 4; // guard against a runaway tool-use loop

function mean(xs) {
  const v = xs.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}

// Compresses everything the app knows about the athlete into a compact
// facts block, instead of dumping raw day-by-day arrays into the prompt —
// keeps token usage sane even with years of imported history, and gives
// Claude pre-computed numbers instead of asking it to eyeball trends from
// a wall of JSON.
function buildContext({ activities, wellness, scorecard, verdict, plan, body, importSummary, notes }) {
  const last14 = wellness.slice(-14);
  const prev14 = wellness.slice(-28, -14);
  const last90 = wellness.slice(-90);

  const byDiscipline = {};
  for (const a of activities) {
    byDiscipline[a.discipline] = byDiscipline[a.discipline] || { count: 0, hours: 0, elevationM: 0 };
    byDiscipline[a.discipline].count += 1;
    byDiscipline[a.discipline].hours += a.durationMin / 60;
    byDiscipline[a.discipline].elevationM += a.elevationGainM || 0;
  }
  for (const d of Object.values(byDiscipline)) d.hours = round1(d.hours);

  const recentActivities = activities.slice(0, 10).map((a) => ({
    date: a.startTime?.slice(0, 10),
    discipline: a.discipline,
    name: a.name,
    durationMin: Math.round(a.durationMin),
    distanceKm: a.distanceKm,
    elevationGainM: a.elevationGainM,
    avgHR: a.avgHR,
  }));

  return {
    today: new Date().toISOString().slice(0, 10),
    trainingScore: scorecard ? { score: scorecard.score, components: scorecard.comp.map((c) => ({ name: c.k, value: Math.round(c.v), detail: c.detail })) } : null,
    verdict: verdict ? { text: verdict.text, sub: verdict.sub.replace(/<\/?b>/g, '') } : null,
    todaysPlan: plan ? { title: plan.title, discipline: plan.disciplineLabel, intensity: plan.intensity, detail: plan.detail, reason: plan.reason } : null,
    last14Days: {
      avgSleepHours: round1(mean(last14.map((d) => d.sleepHours))),
      avgRestingHR: round1(mean(last14.map((d) => d.restingHR))),
      avgBodyBatteryHigh: round1(mean(last14.map((d) => d.bodyBatteryHigh))),
      avgStress: round1(mean(last14.map((d) => d.stressAvg))),
    },
    previous14Days: {
      avgSleepHours: round1(mean(prev14.map((d) => d.sleepHours))),
      avgRestingHR: round1(mean(prev14.map((d) => d.restingHR))),
    },
    last90DaysTrainingByDiscipline: byDiscipline,
    recentActivities,
    bodyComposition: body
      ? {
          date: body.date,
          weightLbs: body.weight_lbs,
          composition: Object.fromEntries(Object.entries(body.composition || {}).map(([k, v]) => [k, `${v.value} ${v.unit || ''}`.trim()])),
          trendAvailable: Boolean(body.history && body.history.length > 1),
        }
      : null,
    importedHistoryRange: importSummary ? { first: importSummary.first, last: importSummary.last, totalDays: importSummary.totalDays, totalWorkouts: importSummary.totalWorkouts } : null,
    // Facts the athlete has told THIS coach in a past conversation (see the
    // remember_context tool below) -- upcoming trips/objectives to train
    // toward, and standing equipment/schedule facts. Always weigh these
    // when they're relevant to the question asked (e.g. tapering toward an
    // objective date, or suggesting home-equipment sessions on the days
    // that fit).
    remembered: (notes || []).map((n) => ({ note: n.note, category: n.category, notedOn: n.createdAt?.slice(0, 10) })),
    note: `last90DaysTrainingByDiscipline and recentActivities are computed from whatever activity history is currently loaded (up to ${activities.length} activities); wellness averages are computed from the last90Days.length=${last90.length} days of daily wellness records available.`,
  };
}

const TOOLS = [
  {
    name: 'remember_context',
    description:
      "Save a durable fact about the athlete for future conversations -- an upcoming trip/event/objective (a climbing trip, a race, a deadline that should shape training), or a standing fact about their equipment, schedule, or situation (e.g. they have a hangboard or balance board at home, which days they work from home). Call this as soon as the athlete mentions something like this -- don't ask permission first, just save it and briefly confirm. Check the 'remembered' list already in your data snapshot first so you don't save a near-duplicate of something already on record.",
    input_schema: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description:
            "The fact, written concisely in third person so it reads naturally in a later conversation, e.g. 'Climbing trip to Red River Gorge planned for the week of Nov 10' or 'Has a hangboard at home and works from home 2-3 days/week, so can fit short power sessions in during the day.'",
        },
        category: { type: 'string', enum: ['objective', 'equipment', 'schedule', 'other'] },
      },
      required: ['note', 'category'],
    },
  },
];

const SYSTEM_PROMPT = `You are an experienced endurance and strength coach embedded in "Alpine Log", a personal training-data dashboard for an athlete based in Chicago who bikes, runs, and climbs (gym climbing, not alpine), and is also working on slacklining. You are given a JSON snapshot of that athlete's real recent training and health data with every message — always ground your answers in it rather than generic advice, and cite specific numbers from it when relevant. The snapshot's "remembered" array holds durable facts they've told you in past conversations (upcoming trips/objectives, equipment, schedule) -- factor these in whenever relevant (e.g. tapering toward an objective date, suggesting a home-hangboard session on a day they've said they work from home) without being asked to re-derive them each time.

You have a remember_context tool -- use it proactively whenever the athlete mentions a new trip, objective, deadline, or a standing fact about their equipment or schedule. Don't ask for permission, just call it and briefly acknowledge what you saved.

Rules:
- Be direct, concise, and specific. No filler, no disclaimers-as-padding, no markdown headers — plain prose, short paragraphs, occasional short bullet list if genuinely clearer.
- You are not a doctor. For anything that sounds like a medical concern (chest pain, injury, illness) say so plainly and suggest seeing a professional, rather than diagnosing.
- If the data doesn't cover what's being asked (e.g. they ask about a year the import doesn't include), say what you don't have rather than guessing.
- Keep replies to a few sentences unless the question genuinely calls for more (e.g. "build me a training plan").`;

function executeTool(name, input) {
  if (name === 'remember_context') {
    const saved = contextNotes.addNote({ note: input.note, category: input.category });
    return saved ? `Saved: "${saved.note}" (${saved.category}).` : 'Nothing to save — the note was empty.';
  }
  return `Unknown tool: ${name}`;
}

async function callClaude(apiKey, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 700,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Claude API returned ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

function extractText(content) {
  return (content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

async function chatReply({ messages, context }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return "The coach feature needs an ANTHROPIC_API_KEY set on the server to work — ask whoever manages this deployment to add one (see garmin-viewer/.env.example).";
  }

  const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);
  // Attach the data snapshot to the latest user turn so it's fresh context
  // right where the model needs it, without re-sending it on every turn's
  // history entry.
  const conversation = trimmed.map((m, i) =>
    i === trimmed.length - 1 && m.role === 'user'
      ? { role: 'user', content: `${m.content}\n\n---\nCurrent data snapshot (JSON):\n${JSON.stringify(context)}` }
      : { role: m.role, content: m.content }
  );

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const data = await callClaude(apiKey, conversation);

      if (data.stop_reason !== 'tool_use') {
        const text = extractText(data.content);
        return text || "Didn't get a usable reply back — try asking again.";
      }

      // Run every tool call in this turn, then hand the results back so
      // Claude can produce its actual reply with them incorporated.
      conversation.push({ role: 'assistant', content: data.content });
      const toolResults = data.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: executeTool(b.name, b.input),
        }));
      conversation.push({ role: 'user', content: toolResults });
    }
    return "That took more back-and-forth than expected — try rephrasing your question.";
  } catch (err) {
    console.error('[chat] Claude call failed:', err.message);
    return `Couldn't reach the coach right now (${err.message}). Try again in a moment.`;
  }
}

module.exports = { chatReply, buildContext };
