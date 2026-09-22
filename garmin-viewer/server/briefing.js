// Morning/evening briefing text. Built from a deterministic template so the
// app always works with zero configuration; if ANTHROPIC_API_KEY is set,
// the same structured facts are handed to Claude to phrase more naturally.

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

function fmtHours(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

function morningTemplate({ readiness, acwr, plan, yesterday }) {
  const lines = [];
  lines.push(
    `Good morning. Readiness is ${readiness.score}/100 today` +
      (yesterday ? `, after ${fmtHours(yesterday.durationMin)} of ${yesterday.disciplineLabel.toLowerCase()} yesterday.` : '.')
  );
  if (readiness.factors.sleepScore != null) {
    const hrvBit = readiness.factors.hrvStatus ? `, HRV status ${readiness.factors.hrvStatus.toLowerCase()}` : '';
    lines.push(`Sleep score ${readiness.factors.sleepScore}, resting HR ${readiness.factors.restingHR}${hrvBit}.`);
  }
  lines.push(`7-day training load is ${acwr.status.replace('-', ' ')} (ACWR ${acwr.ratio}).`);
  lines.push(`Today's suggestion: ${plan.title} (${plan.disciplineLabel}) — ${plan.detail}`);
  lines.push(plan.reason);
  return lines.join(' ');
}

function eveningTemplate({ todayActivities, totalLoad, readiness }) {
  if (!todayActivities.length) {
    return `No activity logged yet today. Recovery is looking ${readiness.score >= 60 ? 'solid' : 'a bit low'} — a short walk or mobility session before bed keeps tomorrow on track.`;
  }
  const totalMin = todayActivities.reduce((s, a) => s + a.durationMin, 0);
  const totalVert = todayActivities.reduce((s, a) => s + a.elevationGainM, 0);
  const names = todayActivities.map((a) => `${a.icon} ${a.name}`).join(', ');
  return (
    `Today: ${names} — ${fmtHours(totalMin)} total` +
    (totalVert ? `, ${Math.round(totalVert)}m of gain` : '') +
    `. Session load added ~${totalLoad} to your 7-day total. ` +
    (totalLoad > 60
      ? 'That was a big one — prioritize sleep and easy movement tomorrow.'
      : 'Nicely sustainable — recover well and you can go again tomorrow.')
  );
}

async function phraseWithClaude(kind, facts, fallbackText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fallbackText;
  try {
    const prompt =
      kind === 'morning'
        ? `Write a short (2-3 sentence), encouraging morning training briefing for a mountain athlete (climber/mountain biker/mountaineer) based on these facts. Be specific and concrete, no fluff, no emoji, no markdown. Facts: ${JSON.stringify(facts)}`
        : `Write a short (2-3 sentence) evening wrap-up for a mountain athlete summarizing today's training and what it means for tomorrow's recovery, based on these facts. Be specific and concrete, no fluff, no emoji, no markdown. Facts: ${JSON.stringify(facts)}`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return fallbackText;
    const data = await res.json();
    const text = data.content && data.content[0] && data.content[0].text;
    return text ? text.trim() : fallbackText;
  } catch (err) {
    return fallbackText;
  }
}

async function buildMorningBriefing(context) {
  const fallback = morningTemplate(context);
  return phraseWithClaude('morning', context, fallback);
}

async function buildEveningBriefing(context) {
  const fallback = eveningTemplate(context);
  return phraseWithClaude('evening', context, fallback);
}

module.exports = { buildMorningBriefing, buildEveningBriefing };
