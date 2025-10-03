/* Player Damage Router — PF2e (v2.0.6-socketlib-replace+auto-self)
 * Replace-only: hides PF2e apply rows and inserts PDR lookalike rows per damage index.
 * Player -> GM via SocketLib (no whispers). GM sets TARGETS ONLY by UUID, optional scene auto-view, applies, then restores.
 * Supports main / splash / persistent and healing-only rows; Block toggle per index.
 * Auto self-target: when a player clicks a healing row with no targets, the module selects the speaker’s token (or their PC token) automatically.
 * PF2e 7.5.x • Foundry v13+ (renderChatMessageHTML).
 *
 * Settings:
 *  - client  debug                        : verbose logging + row highlights
 *  - client  suppressGmToasts            : hide GM error toast
 *  - world   postGmSummary               : GM posts a tiny PDR summary after apply
 *  - world   gmViewTargetScene           : GM temporarily views the targets’ scene when applying
 *  - world   suppressSystemApplyMessage  : delete PF2e “Damage Taken/Healing” feedback after apply
 *
 * Requires: socketlib module active AND module.json has `"socket": true`
 */

(() => {
  const MOD = "player-damage-router";
  const VER = "2.0.6-socketlib-replace+auto-self";
  const EVT = "gmApplyFromCard";

  // ---------- namespace & hot-reload guard ----------
  const ns = (globalThis.PDR ??= {});
  try { ns.dispose?.(); } catch {}
  ns.dispose = () => {
    try { Hooks.off("renderChatMessageHTML", ns.onRender); } catch {}
    try { Hooks.off("ready", ns._readyHook); } catch {}
    try { Hooks.off("socketlib.ready", ns._sockHook); } catch {}
    ns.onRender = ns._readyHook = ns._sockHook = null;
    ns._sockRegistered = false;
  };

  // ---------- settings ----------
  Hooks.once("init", () => {
    game.settings.register(MOD, "debug", {
      name: "Debug logging",
      hint: "Logs detection, payloads, selection, and apply flow (adds dashed outlines).",
      scope: "client", config: true, type: Boolean, default: false
    });
    game.settings.register(MOD, "suppressGmToasts", {
      name: "Suppress GM pop-ups",
      hint: "Hide error toasts on the GM client.",
      scope: "client", config: true, type: Boolean, default: true
    });
    game.settings.register(MOD, "postGmSummary", {
      name: "GM: Post summary to chat",
      hint: "After applying, GM posts a tiny PDR summary message.",
      scope: "world", config: true, type: Boolean, default: false
    });
    game.settings.register(MOD, "gmViewTargetScene", {
      name: "GM: Auto-view targets’ scene while applying",
      hint: "Temporarily switches GM view to the scene containing targets.",
      scope: "world", config: true, type: Boolean, default: true
    });
    game.settings.register(MOD, "suppressSystemApplyMessage", {
      name: "Hide PF2e 'Damage Taken / Healing' feedback",
      hint: "After applying, automatically delete PF2e’s post-apply feedback messages.",
      scope: "world", config: true, type: Boolean, default: false
    });

    if (!game.modules.get("socketlib")?.active) {
      ui.notifications?.error?.(`${MOD}: SocketLib is not active. Enable the "socketlib" module and ensure "socket": true in your module.json.`);
    }
  });

  // ---------- debug helpers ----------
  const DBG = () => { try { return !!game.settings.get(MOD, "debug"); } catch { return false; } };
  const log  = (...a) => DBG() && console.log(`%c[PDR]%c`, "color:#7c3aed;font-weight:700", "color:inherit", ...a);
  const warn = (...a) => DBG() && console.warn(`[PDR]`, ...a);
  const err  = (...a) => console.error(`[${MOD}]`, ...a);
  const highlight = (el, color="#7c3aed") => {
    if (!DBG() || !el || !el.style) return;
    const prev = el.style.outline;
    el.style.outline = `2px dashed ${color}`;
    setTimeout(() => { try { el.style.outline = prev ?? ""; } catch {} }, 800);
  };

  // ---------- tiny console API ----------
  ns.version = VER;
  ns.setDebug = async (on=true) => game.settings.set(MOD, "debug", !!on);
  ns.ping = async () => {
    if (!ns.socket) { warn("Socket not ready."); return { pong: false }; }
    if (game.user.isGM) { log("PDR.ping() (GM): pong"); return { pong: true, gm: game.user.id, at: Date.now() }; }
    const r = await ns.socket.executeAsGM("_pdrPing", { from: game.user.id, at: Date.now() });
    log("PDR.ping():", r);
    return r;
  };

  // ---------- socketlib wiring (idempotent) ----------
  function registerSocketlib() {
    if (ns._sockRegistered) { log("socketlib already registered"); return true; }
    if (!window.socketlib) return false;
    try {
      ns.socket = socketlib.registerModule(MOD);
      ns.socket.register(EVT, ns.gmApplyFromCard);
      ns.socket.register("_pdrPing", ({from, at}) => {
        log("GM received ping from", from, "at", new Date(at).toISOString());
        return { pong: true, gm: game.user.id, at: Date.now() };
      });
      ns._sockRegistered = true;
      log("socketlib registered ✓");
      return true;
    } catch (e) {
      console.error("[PDR] socketlib registration failed", e);
      return false;
    }
  }

  ns._sockHook = () => registerSocketlib();
  Hooks.once("socketlib.ready", ns._sockHook);

  ns._readyHook = () => {
    log(`ready v${VER} | isGM=${game.user.isGM}`);
    if (!ns._sockRegistered && window.socketlib) registerSocketlib(); // handle load-order race
    if (!ns._sockRegistered) warn("SocketLib not registered yet; will try again if available.");
  };
  Hooks.once("ready", ns._readyHook);

  // ---------- GM de-dupe ----------
  ns._recentNonces = new Set();
  function seenNonce(nonce) {
    if (!nonce) return false;
    if (ns._recentNonces.has(nonce)) return true;
    ns._recentNonces.add(nonce);
    if (ns._recentNonces.size > 200) ns._recentNonces = new Set([...ns._recentNonces].slice(-100));
    return false;
  }

  // ---------- GM helpers ----------
  // TARGETS-ONLY selection: clear controls & targets; set only user.targets based on UUIDs
  async function PDR_selectTokensForGM(targetUuids = []) {
    const tokens = targetUuids.map(u => {
      try { const d = fromUuidSync(u); return d?.object ?? null; } catch { return null; }
    }).filter(Boolean);

    const noop = async () => {};
    if (!tokens.length) { warn("GM selectTokens: no resolvable tokens for", targetUuids); return { tokens: [], restore: noop }; }

    const prev = {
      sceneId: canvas.scene?.id ?? null,
      controlledIds: canvas.tokens?.controlled?.map(t => t.id) ?? [],
      targets: new Set(game.user.targets)
    };

    const tgtScene = tokens[0]?.document?.parent;
    log("GM selectTokens (targets-only):", { count: tokens.length, scene: tgtScene?.id, names: tokens.map(t => t.name) });

    if (game.settings.get(MOD, "gmViewTargetScene") && tgtScene?.id && canvas.scene?.id !== tgtScene.id) {
      try { await tgtScene.view(); } catch {}
      await new Promise(r => setTimeout(r, 120));
    }

    // Clear both; then set ONLY targets
    try { canvas.tokens?.releaseAll?.(); } catch {}
    try { game.user.updateTokenTargets(new Set()); } catch {}
    try { game.user.updateTokenTargets(new Set(tokens)); } catch {}

    const restore = async () => {
      try { canvas.tokens?.releaseAll?.(); } catch {}

      // restore previous controlled tokens
      for (const id of prev.controlledIds) {
        const tok = canvas.tokens?.get(id);
        if (tok) { try { tok.control({ releaseOthers: false }); } catch {} }
      }

      // restore previous targets
      try { game.user.updateTokenTargets(prev.targets); } catch {}

      // restore previous scene view if changed
      if (game.settings.get(MOD, "gmViewTargetScene") && prev.sceneId && canvas.scene?.id !== prev.sceneId) {
        const prevScene = game.scenes.get(prev.sceneId);
        if (prevScene) { try { await prevScene.view(); } catch {} }
      }
      log("GM restored previous selection/scene.");
    };

    return { tokens, restore };
  }

  async function ensureCardInDOM(messageId) {
    if (document.querySelector(`li.chat-message[data-message-id="${messageId}"]`)) return;
    try { await ui.chat?.render?.(true); } catch {}
  }

  // ---------- GM: apply on a specific roll index (de-duped by nonce) ----------
  async function gmApplyFromCard(payload) {
    try {
      const { messageId, rollIndex = "0", application = "full", useBlock = false, targetUuids = [], _nonce } = payload ?? {};
      if (seenNonce(_nonce)) { warn("GM apply: duplicate nonce ignored", _nonce); return; }
      log("GM apply received:", payload);

      const message = game.messages.get(messageId);
      if (!message) { warn("GM apply: message not found", messageId); return; }

      await ensureCardInDOM(messageId);
      const li = document.querySelector(`li.chat-message[data-message-id="${messageId}"]`);
      if (!li) { warn("GM apply: chat LI not found"); return; }

      // Strictly pick the native section for the requested index
      const selector = `section.damage-application[data-roll-index="${rollIndex}"]:not(.pdr-controls)`;
      const section = li.querySelector(selector) || li.querySelector(`section.damage-application:not(.pdr-controls)`);
      if (!section) { warn("GM apply: native section not found", { selector }); return; }
      highlight(section, "#22c55e");

      const { tokens, restore } = await PDR_selectTokensForGM(targetUuids);
      if (!tokens.length) {
        ui.notifications?.warn?.("PDR: No resolvable targets on GM side.");
        return;
      }

      // Optionally suppress PF2e “Damage Taken / Healing” feedback created immediately after apply
      let suppressHandler = null;
      if (game.settings.get(MOD, "suppressSystemApplyMessage")) {
        const start = Date.now();
        suppressHandler = (msg) => {
          try {
            const f = msg?.flags?.pf2e;
            const isFeedback =
              f?.context?.type === "damage-taken" ||
              /damage\s*taken|healing/i.test(msg?.content || "");
            const recent = Date.now() - start < 1500;
            if (isFeedback && recent) { msg.delete?.(); }
          } catch {}
        };
        Hooks.on("createChatMessage", suppressHandler);
      }

      try {
        if (useBlock) {
          const blockBtn = section.querySelector('button[data-action="shieldBlock"]');
          if (blockBtn) { log("GM click shieldBlock"); try { blockBtn.click(); } catch {} }
        }

        let mult = "1";
        if (application === "half") mult = "0.5";
        else if (application === "double") mult = "2";
        else if (application === "healing") mult = "-1";

        const applyBtn = section.querySelector(`button[data-action="applyDamage"][data-multiplier="${mult}"]`)
                       || section.querySelector('button[data-action="applyDamage"]');
        if (!applyBtn) { warn("GM apply: apply button not found for multiplier", mult); return; }

        log("GM clicking applyDamage", { mult, tokens: tokens.map(t => t.name) });
        highlight(applyBtn, "#22c55e");
        applyBtn.click();
      } finally {
        setTimeout(() => { restore(); }, 350);
        if (suppressHandler) setTimeout(() => Hooks.off("createChatMessage", suppressHandler), 1500);
      }

      if (game.settings.get(MOD, "postGmSummary")) {
        ChatMessage.create({
          speaker: { alias: "PDR" },
          content: `<small>PDR: ${application}${useBlock ? " [Block]" : ""} from card ${messageId} (roll ${rollIndex}) to ${tokens.length} target(s).</small>`
        });
      }
    } catch (e) {
      err("GM apply error", e);
      if (!game.settings.get(MOD, "suppressGmToasts")) ui.notifications?.error("PDR: apply failed (see console).");
    }
  }
  ns.gmApplyFromCard = gmApplyFromCard;

  // ---------- UI helpers ----------
  function hideSectionByIndex(rootEl, rollIndex) {
    const card = rootEl?.closest?.("li.chat-message") || document.body;
    const natives = card.querySelectorAll(`section.damage-application[data-roll-index="${rollIndex}"]:not(.pdr-controls)`);
    const pdrs    = card.querySelectorAll(`section.damage-application.pdr-controls[data-roll-index="${rollIndex}"]`);
    natives.forEach(el => el.style.display = "none");
    pdrs.forEach(el => el.style.display = "none");
    log("Hide rows for rollIndex", rollIndex, { natives: natives.length, pdrs: pdrs.length });
  }

  function isHealingOnly(nativeSection) {
    return !!nativeSection.querySelector('button[data-action="applyDamage"][data-multiplier="-1"]') ||
           !!nativeSection.querySelector('button.healing-only[data-action="applyDamage"]');
  }

  function buildPdrRow(rollIndex, healing) {
    const row = document.createElement("section");
    row.className = "damage-application pdr-controls";
    row.dataset.rollIndex = String(rollIndex);

    if (healing) {
      row.innerHTML = `
        <button type="button" class="pdr-apply healing-only" data-app="healing"
          title="[Click] Apply full healing to selected tokens.&#10;[Shift-Click] Adjust value before applying.">
          <span class="fa-stack fa-fw">
            <i class="fa-solid fa-heart fa-stack-2x"></i>
            <i class="fa-solid fa-plus fa-inverse fa-stack-1x"></i>
          </span>
          <span class="label">Apply Healing</span>
        </button>
      `;
      return row;
    }

    row.innerHTML = `
      <button type="button" class="pdr-apply" data-app="full"
        title="[Click] Apply full damage to selected tokens.&#10;[Shift-Click] Adjust value before applying.">
        <i class="fa-solid fa-heart-crack fa-fw"></i>
        <span class="label">Damage</span>
      </button>
      <button type="button" class="pdr-apply half-damage" data-app="half"
        title="[Click] Apply half damage to selected tokens.&#10;[Shift-Click] Adjust value before applying.">
        <i class="fa-solid fa-heart-crack fa-fw"></i>
        <span class="label">Half</span>
      </button>
      <button type="button" class="pdr-apply" data-app="double"
        title="[Click] Apply double damage to selected tokens.&#10;[Shift-Click] Adjust value before applying.">
        <img src="systems/pf2e/icons/damage/double.svg">
        <span class="label">Double</span>
      </button>
      <button type="button" class="pdr-block dice-total-shield-btn"
        title="[Click] Toggle the shield block status of the selected tokens before applying.">
        <i class="fa-solid fa-shield-blank fa-fw"></i>
        <span class="label">Block</span>
      </button>
    `;
    return row;
  }

  // ---------- Player UI: replace native rows with PDR rows ----------
  ns.onRender = (message, htmlEl) => {
    try {
      if (game.system.id !== "pf2e") return;
      if (!message?.isContentVisible) return;
      if (!message?.flags?.pf2e) return;

      const sections = Array.from(htmlEl.querySelectorAll("section.damage-application:not(.pdr-controls)"));
      if (!sections.length) return;

      for (const native of sections) {
        const rollIndex = native.dataset.rollIndex ?? "0";
        const healing   = isHealingOnly(native);

        // Hide native row & avoid duplicates per index
        native.style.display = "none";

        let row = native.parentElement?.querySelector(`section.damage-application.pdr-controls[data-roll-index="${rollIndex}"]`);
        if (!row) {
          row = buildPdrRow(rollIndex, healing);
          native.insertAdjacentElement("afterend", row);
          log("Render PDR row", { messageId: message.id, rollIndex, healing });
          highlight(row);
        }

        // Bind once per row
        if (row.dataset.pdrBound === "1") continue;
        row.dataset.pdrBound = "1";

        let blockOn = false;
        const blockBtn = row.querySelector(".pdr-block");
        const setBlockVisual = () => {
          if (!blockBtn) return;
          blockBtn.setAttribute("aria-pressed", blockOn ? "true" : "false");
          blockBtn.classList.toggle("active", !!blockOn);
          blockBtn.style.opacity = blockOn ? "1" : "0.75";
        };
        setBlockVisual();

        row.addEventListener("click", async (ev) => {
          const btn = ev.target.closest("button");
          if (!btn) return;
          ev.stopPropagation();

          if (row.dataset.pdrBusy === "1") { warn("Row already handled; ignoring double click."); return; }

          if (btn.classList.contains("pdr-block")) {
            blockOn = !blockOn;
            setBlockVisual();
            log("Toggle Block", { rollIndex, blockOn });
            return;
          }
          if (!btn.classList.contains("pdr-apply")) return;

          // Guard against double sends
          row.dataset.pdrBusy = "1";
          row.querySelectorAll("button").forEach(b => b.disabled = true);

          const application = btn.dataset.app || (btn.classList.contains("healing-only") ? "healing" : "full");

          // Collect current targets; if healing row and no targets, auto-self-target
          let targetUuids = [...game.user.targets].map(t => t?.document?.uuid ?? t?.uuid).filter(Boolean);
          if (!targetUuids.length && application === "healing") {
            const sp = message?.speaker ?? {};
            // Prefer speaker token + scene from the card
            if (sp.token && sp.scene) {
              const uuid = `Scene.${sp.scene}.Token.${sp.token}`;
              try { if (fromUuidSync(uuid)) targetUuids = [uuid]; } catch {}
            }
            // Fallback: user’s character token on current scene
            if (!targetUuids.length && game.user.character) {
              const tok = canvas.tokens?.placeables?.find(t => t.actor?.id === game.user.character.id);
              if (tok) targetUuids = [tok.document.uuid];
            }
            log("Auto-self target (healing row):", targetUuids);
          }

          if (!targetUuids.length) {
            ui.notifications?.warn?.("PDR: No targets selected.");
            row.dataset.pdrBusy = "0";
            row.querySelectorAll("button").forEach(b => b.disabled = false);
            return;
          }

          const nonce = (crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
          const payload = {
            messageId: message.id,
            rollIndex: String(rollIndex),
            application,       // "full"|"half"|"double"|"healing"
            useBlock: !!blockOn,
            targetUuids,
            _nonce: nonce
          };

          log("Player click → route", payload);
          highlight(row, "#2563eb");

          try {
            if (game.user.isGM) {
              await gmApplyFromCard(payload);
            } else {
              if (!ns.socket) { ui.notifications?.error?.(`${MOD}: SocketLib not ready.`); return; }
              await ns.socket.executeAsGM(EVT, payload);
            }
          } catch (e) {
            err("route/apply failed", e);
            if (!game.settings.get(MOD, "suppressGmToasts")) ui.notifications?.error("PDR: apply failed (see console).");
          } finally {
            hideSectionByIndex(row, rollIndex);
          }
        }, { once: false });
      }
    } catch (e) {
      err("renderChatMessageHTML error", e);
    }
  };
  Hooks.on("renderChatMessageHTML", ns.onRender);
})();
