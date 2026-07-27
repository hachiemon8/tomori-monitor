import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const STALL_MS = 30 * 60 * 1000;
const RECHECK_AFTER_HEAL_MS = 15 * 60 * 1000;
const ALERT_TO = process.env.ALERT_TO || "hachiemon8@gmail.com";

const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN || "";
const RAILWAY_WORKER_SERVICE_ID = process.env.RAILWAY_WORKER_SERVICE_ID || "";
const RAILWAY_SUBTITLE_SERVICE_ID = process.env.RAILWAY_SUBTITLE_SERVICE_ID || "";
const RAILWAY_ENVIRONMENT_ID = process.env.TARGET_ENVIRONMENT_ID || process.env.RAILWAY_ENVIRONMENT_ID || "";

async function sendAlert(subject, body) {
  if (!process.env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY 未設定のため通知できません");
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
        html: '<pre style="font-family:monospace;font-size:13px;white-space:pre-wrap">' + body + "</pre>",
      }),
    });
    console.log("通知送信: " + subject + " (status " + res.status + ")");
  } catch (e) {
    console.error("通知送信失敗:", e.message);
  }
}

async function fetchAll(table, build) {
  let rows = [];
  let from = 0;
  while (true) {
    let q = supabase.from(table).select(build.select).range(from, from + 999);
    if (build.apply) q = build.apply(q);
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
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return (data && data.value) || null;
}

async function setState(key, value) {
  await supabase.from("monitor_state").upsert({
    key: key,
    value: value,
    updated_at: new Date().toISOString(),
  });
}

async function collectMetrics() {
  const videos = await fetchAll("videos", { select: "status" });
  const vc = {};
  for (const v of videos) vc[v.status || "null"] = (vc[v.status || "null"] || 0) + 1;

  const transcriptDone = vc.published || 0;
  const transcriptRemaining = (vc.pending || 0) + (vc.processing || 0);

  const subs = await fetchAll("subtitles", {
    select: "video_id",
    apply: function (q) { return q.eq("lang", "ja"); },
  });
  const subtitleDone = new Set(subs.map(function (x) { return x.video_id; })).size;

  const cands = await fetchAll("transcripts", {
    select: "video_id",
    apply: function (q) {
      return q.eq("lang", "ja").not("segments", "is", null).lt("subtitle_fail_count", 3);
    },
  });
  const subtitleCandidates = new Set(cands.map(function (x) { return x.video_id; })).size;
  const subtitleRemaining = Math.max(0, subtitleCandidates - subtitleDone);

  const unedited = await fetchAll("transcripts", {
    select: "video_id",
    apply: function (q) { return q.eq("lang", "ja").is("edited_text", null); },
  });
  const uneditedCount = new Set(unedited.map(function (x) { return x.video_id; })).size;

  const noseg = await fetchAll("transcripts", {
    select: "video_id",
    apply: function (q) { return q.eq("lang", "ja").is("segments", null).not("edited_text", "is", null); },
  });
  const noSegCount = new Set(noseg.map(function (x) { return x.video_id; })).size;

  return {
    noSegCount: noSegCount,
    uneditedCount: uneditedCount,
    transcriptDone: transcriptDone,
    transcriptRemaining: transcriptRemaining,
    transcriptStatus: vc,
    subtitleDone: subtitleDone,
    subtitleCandidates: subtitleCandidates,
    subtitleRemaining: subtitleRemaining,
  };
}

async function healStuckProcessing() {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("videos")
    .update({ status: "pending" })
    .eq("status", "processing")
    .lt("updated_at", cutoff)
    .select("id");
  const n = (data || []).length;
  if (n > 0) console.log("  [復旧] processing " + n + "本を pending に戻しました");
  return n;
}

async function healSubtitleLoop() {
  const { data } = await supabase
    .from("transcripts")
    .update({ subtitle_fail_count: 3 })
    .eq("lang", "ja")
    .gte("subtitle_fail_count", 1)
    .lt("subtitle_fail_count", 3)
    .select("video_id");
  const n = (data || []).length;
  if (n > 0) console.log("  [復旧] 字幕生成に失敗し続けている " + n + "本を除外しました");
  return n;
}

async function restartRailwayService(serviceId, label) {
  if (!RAILWAY_TOKEN || !serviceId || !RAILWAY_ENVIRONMENT_ID) {
    console.log("  [復旧] Railway再起動はスキップ（トークンまたはID未設定）");
    return false;
  }
  const query = "mutation ServiceInstanceRedeploy($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }";
  try {
    const res = await fetch("https://backboard.railway.com/graphql/v2", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + RAILWAY_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: query,
        variables: { serviceId: serviceId, environmentId: RAILWAY_ENVIRONMENT_ID },
      }),
    });
    const json = await res.json();
    if (json.errors) {
      console.log("  [復旧] " + label + " 再起動失敗: " + JSON.stringify(json.errors).slice(0, 150));
      return false;
    }
    console.log("  [復旧] " + label + " を再起動しました");
    return true;
  } catch (e) {
    console.log("  [復旧] " + label + " 再起動エラー: " + e.message);
    return false;
  }
}

async function check(name, done, remaining, healFn, serviceId, metrics) {
  const key = "pipeline_" + name;
  const prev = await getState(key);
  const now = Date.now();

  if (remaining <= 0) {
    if (prev && prev.phase && prev.phase !== "complete") {
      await sendAlert(
        "[tomori] " + name + " が完了しました",
        name + " の処理がすべて終わりました。\n\n" +
        "完了本数: " + done + "\n\n" +
        "--- 全体 ---\n" +
        "文字起こし: " + metrics.transcriptDone + " 完了 / 残り " + metrics.transcriptRemaining + "\n" +
        "字幕生成: " + metrics.subtitleDone + " / " + metrics.subtitleCandidates
      );
    }
    await setState(key, { done: done, since: now, phase: "complete" });
    return "complete";
  }

  if (!prev || prev.done !== done) {
    await setState(key, { done: done, since: now, phase: "ok" });
    return "ok";
  }

  const stalledMs = now - (prev.since || now);
  const stalledMin = Math.round(stalledMs / 60000);
  const phase = prev.phase || "ok";

  if (stalledMs < STALL_MS) {
    return "waiting(" + stalledMin + "分)";
  }

  if (phase === "ok" || phase === "waiting") {
    console.log("  " + name + " が " + stalledMin + "分停止 → 自動復旧を試みます");
    let healed = 0;
    if (healFn) healed += await healFn();
    await setState(key, {
      done: done,
      since: prev.since,
      phase: "healing",
      healedAt: now,
      healedCount: healed,
    });
    return "HEALING(" + healed + "件)";
  }

  if (phase === "healing") {
    if (now - (prev.healedAt || now) < RECHECK_AFTER_HEAL_MS) {
      return "healing(様子見)";
    }
    console.log("  " + name + " が復旧後も停止 → サービスを再起動します");
    const ok = await restartRailwayService(serviceId, name);
    await setState(key, {
      done: done,
      since: prev.since,
      phase: ok ? "restarted" : "restart_failed",
      restartedAt: now,
    });
    return ok ? "RESTARTED" : "RESTART_FAILED";
  }

  if (phase === "restarted" || phase === "restart_failed") {
    if (now - (prev.restartedAt || now) < RECHECK_AFTER_HEAL_MS) {
      return phase + "(様子見)";
    }
    await sendAlert(
      "[tomori] " + name + " が復旧できません",
      name + " が " + stalledMin + " 分間停止しています。\n" +
      "自動復旧とサービス再起動を試みましたが、進捗が戻りません。\n\n" +
      "完了本数: " + done + "（変化なし）\n" +
      "残り: " + remaining + "\n\n" +
      "--- 全体 ---\n" +
      "文字起こし: " + metrics.transcriptDone + " 完了 / 残り " + metrics.transcriptRemaining + "\n" +
      "  内訳: " + JSON.stringify(metrics.transcriptStatus) + "\n" +
      "字幕生成: " + metrics.subtitleDone + " / " + metrics.subtitleCandidates + "\n\n" +
      "Railway のログを確認してください。"
    );
    await setState(key, { done: done, since: prev.since, phase: "alerted" });
    return "ALERTED";
  }

  return "alerted(通知済)";
}

const RESEG_STALL_MS = 30 * 60 * 1000;

async function checkResegment(m) {
  const now = Date.now();
  if (m.noSegCount === 0) return "完了";
  if (m.transcriptRemaining > 0) return "待機";
  const prev = await getState("reseg_watch");
  if (prev === null || m.noSegCount < prev.count) {
    await setState("reseg_watch", { count: m.noSegCount, since: now, notified: false, restarted: false });
    return "進行中";
  }
  const since = prev.since || now;
  const elapsed = now - since;
  if (elapsed >= RESEG_STALL_MS && prev.notified !== true) {
    if (prev.restarted !== true) {
      const ok = await restartRailwayService(RAILWAY_WORKER_SERVICE_ID, "tomori-worker");
      await setState("reseg_watch", { count: m.noSegCount, since: now, notified: false, restarted: true });
      return ok ? "再起動しました" : "再起動失敗";
    }
    await sendAlert(
      "音声の再取得が止まっています",
      "segments が無い動画の本数が減っていません。<br><br>" +
      "残り " + m.noSegCount + "本<br>" +
      "停滞 " + Math.round(elapsed / 60000) + "分<br><br>" +
      "文字起こしの未処理は0なので、本来は再取得が動いているはずです。<br>" +
      "Railwayの tomori-worker で、一覧のいちばん上（ACTIVE）の View logs を開いてください。<br>" +
      "ログが1行も出ていなければコンテナが無言で停止しています。Redeploy で復旧します。"
    );
    await setState("reseg_watch", { count: m.noSegCount, since: since, notified: true, restarted: true });
    return "通知済み";
  }
  await setState("reseg_watch", { count: m.noSegCount, since: since, notified: prev.notified === true, restarted: prev.restarted === true });
  return "停滞" + Math.round(elapsed / 60000) + "分";
}

const UNEDITED_STALL_MS = 30 * 60 * 1000;

async function checkUnedited(m) {
  const now = Date.now();
  const prev = await getState("unedited_watch");
  if (prev === null || m.uneditedCount <= prev.count) {
    await setState("unedited_watch", { count: m.uneditedCount, since: now, notified: false });
    return "正常";
  }
  const since = prev.since || now;
  const elapsed = now - since;
  if (elapsed >= UNEDITED_STALL_MS && prev.notified !== true) {
    await sendAlert(
      "整形が退避状態のままです",
      "未整形の本数が増え続けています。\n\n" +
      "前回 " + prev.count + "本 → 今回 " + m.uneditedCount + "本\n" +
      "継続時間 " + Math.round(elapsed / 60000) + "分\n\n" +
      "Anthropic APIが上限またはレート制限に達している可能性があります。\n" +
      "復旧後は backfill-edit.mjs で後追い整形してください。"
    );
    await setState("unedited_watch", { count: m.uneditedCount, since: since, notified: true });
    return "通知済み";
  }
  await setState("unedited_watch", { count: m.uneditedCount, since: since, notified: prev.notified === true });
  return "増加中" + Math.round(elapsed / 60000) + "分";
}

async function tick() {
  try {
    const m = await collectMetrics();

    const tr = await check(
      "文字起こし",
      m.transcriptDone,
      m.transcriptRemaining,
      healStuckProcessing,
      RAILWAY_WORKER_SERVICE_ID,
      m
    );

    const sb = await check(
      "字幕生成",
      m.subtitleDone,
      m.subtitleRemaining,
      healSubtitleLoop,
      RAILWAY_SUBTITLE_SERVICE_ID,
      m
    );

    const ue = await checkUnedited(m);
    const rs = await checkResegment(m);

    console.log(
      new Date().toISOString() +
      " | 文字起こし " + m.transcriptDone + " 残" + m.transcriptRemaining + " (" + tr + ")" +
      " | 字幕 " + m.subtitleDone + "/" + m.subtitleCandidates + " (" + sb + ")" +
      " | 未整形 " + m.uneditedCount + " (" + ue + ")" +
      " | 再取得残 " + m.noSegCount + " (" + rs + ")"
    );
  } catch (e) {
    console.error("監視エラー:", e.message);
  }
}

console.log("パイプライン監視（自己修復つき）を開始します");
console.log(
  "設定: チェック " + CHECK_INTERVAL_MS / 60000 + "分ごと / " +
  "停止判定 " + STALL_MS / 60000 + "分 / " +
  "復旧後の再判定 " + RECHECK_AFTER_HEAL_MS / 60000 + "分"
);
console.log("通知先: " + ALERT_TO);
console.log("Railway再起動: " + (RAILWAY_TOKEN ? "有効" : "無効（トークン未設定）"));

tick();
setInterval(tick, CHECK_INTERVAL_MS);
