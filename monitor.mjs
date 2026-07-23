import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CHECK_INTERVAL_MS = 5 * 60 * 1000;      // 5分ごとにチェック
const SUBTITLE_STALL_MS = 30 * 60 * 1000;     // 字幕: 30分動かなければ異常
const TRANSCRIPT_STALL_MS = 60 * 60 * 1000;   // 文字起こし: 60分動かなければ異常
const ALERT_TO = process.env.ALERT_TO || "hachiemon8@gmail.com";

async function sendAlert(subject, body) {
  if (!process.env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY が未設定のため通知できません");
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.RESEND_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "tomori-monitor <onboarding@resend.dev>",
        to: ALERT_TO,
        subject: subject,
        html: "<pre style=\"font-family:monospace;font-size:13px\">" + body + "</pre>",
      }),
    });
    console.log("通知送信: " + subject + " (status " + res.status + ")");
  } catch (e) {
    console.error("通知送信失敗:", e.message);
  }
}

// 1000件制限を回避して全件カウント
async function countAll(table, filterFn) {
  let rows = [];
  let from = 0;
  while (true) {
    let q = supabase.from(table).select("video_id").range(from, from + 999);
    if (filterFn) q = filterFn(q);
    const { data, error } = await q;
    if (error) throw new Error(table + ": " + error.message);
    if (!data || data.length === 0) break;
    rows = rows.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return rows;
}

async function getState(key) {
  const { data } = await supabase
    .from("monitor_state")
    .select("value, updated_at")
    .eq("key", key)
    .maybeSingle();
  return data || null;
}

async function setState(key, value) {
  await supabase.from("monitor_state").upsert({
    key: key,
    value: value,
    updated_at: new Date().toISOString(),
  });
}

async function collectMetrics() {
  // 字幕生成済みの動画数
  const subRows = await countAll("subtitles", function (q) {
    return q.eq("lang", "ja");
  });
  const subtitleDone = new Set(subRows.map(function (x) { return x.video_id; })).size;

  // 文字起こし済み（日本語）
  const trRows = await countAll("transcripts", function (q) {
    return q.eq("lang", "ja");
  });
  const transcriptDone = trRows.length;

  // 字幕生成の対象になりうる動画数（fail_count 3未満・segments あり）
  let pendingRows = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from("transcripts")
      .select("video_id")
      .eq("lang", "ja")
      .not("segments", "is", null)
      .lt("subtitle_fail_count", 3)
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    pendingRows = pendingRows.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const subtitleCandidates = new Set(pendingRows.map(function (x) { return x.video_id; })).size;

  // 文字起こし待ちの動画数
  const { count: videoPending } = await supabase
    .from("videos")
    .select("*", { count: "exact", head: true })
    .eq("status", "processing");

  return {
    subtitleDone: subtitleDone,
    subtitleCandidates: subtitleCandidates,
    subtitleRemaining: Math.max(0, subtitleCandidates - subtitleDone),
    transcriptDone: transcriptDone,
    videoPending: videoPending || 0,
    at: new Date().toISOString(),
  };
}

async function checkStall(name, currentValue, remaining, stallMs, metrics) {
  const key = "stall_" + name;
  const prev = await getState(key);
  const now = Date.now();

  // 処理すべきものが残っていなければ正常
  if (remaining <= 0) {
    if (prev && prev.value && prev.value.alerted) {
      await setState(key, { value: currentValue, since: now, alerted: false });
    }
    return { name: name, status: "complete", value: currentValue };
  }

  // 初回、または値が増えていれば正常
  if (!prev || !prev.value || prev.value.value !== currentValue) {
    await setState(key, { value: currentValue, since: now, alerted: false });
    return { name: name, status: "ok", value: currentValue };
  }

  // 値が変わっていない場合、経過時間を見る
  const stalledFor = now - (prev.value.since || now);

  if (stalledFor >= stallMs && !prev.value.alerted) {
    const mins = Math.round(stalledFor / 60000);
    const body =
      name + " が " + mins + " 分間まったく進んでいません。\n\n" +
      "現在値: " + currentValue + "\n" +
      "残り: " + remaining + "\n\n" +
      "--- 全体の状況 ---\n" +
      "字幕生成済み: " + metrics.subtitleDone + " / " + metrics.subtitleCandidates + "\n" +
      "文字起こし済み: " + metrics.transcriptDone + "\n" +
      "文字起こし待ち: " + metrics.videoPending + "\n\n" +
      "Railway のログを確認してください。\n" +
      "同じ動画を繰り返し処理していれば、ループしている可能性があります。";

    await sendAlert("[tomori] " + name + " が停止しています", body);
    await setState(key, { value: currentValue, since: prev.value.since, alerted: true });
    return { name: name, status: "STALLED", value: currentValue, stalledFor: mins };
  }

  return {
    name: name,
    status: prev.value.alerted ? "stalled(通知済)" : "waiting",
    value: currentValue,
    stalledFor: Math.round(stalledFor / 60000),
  };
}

async function tick() {
  try {
    const m = await collectMetrics();

    const subtitleResult = await checkStall(
      "字幕生成",
      m.subtitleDone,
      m.subtitleRemaining,
      SUBTITLE_STALL_MS,
      m
    );

    const transcriptResult = await checkStall(
      "文字起こし",
      m.transcriptDone,
      m.videoPending,
      TRANSCRIPT_STALL_MS,
      m
    );

    console.log(
      new Date().toISOString() +
      " | 字幕 " + m.subtitleDone + "/" + m.subtitleCandidates +
      " (" + subtitleResult.status + ")" +
      " | 文字起こし " + m.transcriptDone +
      " 待ち" + m.videoPending +
      " (" + transcriptResult.status + ")"
    );
  } catch (e) {
    console.error("監視エラー:", e.message);
  }
}

console.log("パイプライン監視を開始します");
console.log(
  "設定: チェック間隔 " + CHECK_INTERVAL_MS / 60000 + "分 / " +
  "字幕停止判定 " + SUBTITLE_STALL_MS / 60000 + "分 / " +
  "文字起こし停止判定 " + TRANSCRIPT_STALL_MS / 60000 + "分"
);
console.log("通知先: " + ALERT_TO);

tick();
setInterval(tick, CHECK_INTERVAL_MS);
