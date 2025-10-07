/* Player Damage Router — PF2e (v2.2.0)
 * SocketLib • Replace-only UI • Splash-safe (order + rollIndex repair)
 * GM-side queue (serialized applies) • Optional PF2e feedback suppression
 * Simplify persistent math in "damage taken" lines • Healing + self-fallback
 * PF2e 7.5.2 • Foundry v13+
 */
(() => {
  const MOD = "player-damage-router";
  const EVT = "gmApplyFromCard";
  const VER = "2.2.0";

  // ---------- namespace & hot-reload guard ----------
  const ns = (globalThis.PDR ??= {});
  try { ns.dispose?.(); } catch {}
  ns.dispose = () => {
    try { Hooks.off("renderChatMessageHTML", ns.onRender); } catch {}
    try { Hooks.off("ready", ns._readyHook); } catch {}
    try { Hooks.off("socketlib.ready", ns._sockHook); } catch {}
    ns.onRender = ns._readyHook = ns._sockHook = ns.gmApplyFromCard = ns.socket = null;
  };

  // ---------- settings ----------
  Hooks.once("init", () => {
    game.settings.register(MOD, "debug", {
      name: "Debug logging", scope: "client", config: true, type: Boolean, default: false
    });
    game.settings.register(MOD, "serializeGM", {
      name: "Serialize GM apply operations",
      hint: "Queue player requests so the GM applies one at a time, avoiding conflicts while the module controls targets/scene.",
      scope: "world", config: true, type: Boolean, default: true
    });
    game.settings.register(MOD, "gmViewTargetScene", {
      name: "GM: Auto-view targets’ scene while applying",
      scope: "world", config: true, type: Boolean, default: true
    });
    game.settings.register(MOD, "suppressSystemApplyMessage", {
      name: "Hide PF2e 'Damage Taken / Healing' chat lines (GM)",
      scope: "world", config: true, type: Boolean, default: false
    });
    game.settings.register(MOD, "simplifyPersistentMath", {
      name: "Show simplified persistent damage",
      hint: "Replace expressions like “0.5 × 2 persistent fire” with “1 persistent fire” in PF2e damage-taken chat lines.",
      scope: "world", config: true, type: Boolean, default: true
    });

    if (!game.modules.get("socketlib")?.active) {
      ui.notifications?.error?.(`${MOD}: SocketLib not active. Enable it and set "socket": true in module.json.`);
    }
  });

  const DBG  = () => { try { return !!game.settings.get(MOD, "debug"); } catch { return false; } };
  const log  = (...a) => DBG() && console.log(`%c[PDR]%c`, "color:#7c3aed;font-weight:700", "color:inherit", ...a);
  const warn = (...a) => DBG() && console.warn("[PDR]", ...a);
  const err  = (...a) => console.error(`[${MOD}]`, ...a);
  const outline = (el, color="#7c3aed") => {
    if (!DBG() || !el?.style) return;
    const prev = el.style.outline;
    el.style.outline = `2px dashed ${color}`;
    setTimeout(() => { try { el.style.outline = prev ?? ""; } catch {} }, 700);
  };

  // ---------- SocketLib ----------
  function registerSocket() {
    if (!window.socketlib) return false;
    try {
      ns.socket = socketlib.registerModule(MOD);
      ns.socket.register(EVT, ns.gmApplyFromCard);
      log("SocketLib registered ✓");
      return true;
    } catch (e) {
      err("SocketLib registration failed", e);
      return false;
    }
  }
  ns._sockHook = () => registerSocket();
  Hooks.once("socketlib.ready", ns._sockHook);

  ns._readyHook = () => {
    log(`ready v${VER} | isGM=${game.user.isGM}`);
    if (!ns.socket && window.socketlib) registerSocket();
  };
  Hooks.once("ready", ns._readyHook);

  // ---------- helpers ----------
  async function ensureCardInDOM(messageId) {
    if (document.querySelector(`li.chat-message[data-message-id="${messageId}"]`)) return;
    try { await ui.chat?.render?.(true); } catch {}
  }
  function nativeHasBlock(native) {
    return !!native.querySelector('button[data-action="shieldBlock"]');
  }
  function isHealingOnly(native) {
    return !!native.querySelector('button[data-action="applyDamage"][data-multiplier="-1"]')
        || !!native.querySelector('button.healing-only[data-action="applyDamage"]');
  }
  function nativePrimaryLabel(native) {
    const txt = native.querySelector('button[data-action="applyDamage"] span.label')?.textContent?.trim();
    if (txt) return txt;
    if (native.querySelector('.healing-only')) return "Apply Healing";
    return "Damage";
  }
  function labelOf(native) {
    return native.querySelector('button[data-action="applyDamage"] span.label')?.textContent?.trim()?.toLowerCase() ?? "";
  }

  // Choose exact native row to click on GM
  function findNativeRow(li, { order, rollIndex, rowLabel }) {
    const natives = Array.from(li.querySelectorAll('section.damage-application:not(.pdr-controls)'));
    if (!natives.length) return null;

    if (Number.isInteger(order) && order >= 0 && order < natives.length) {
      const s = natives[order];
      log("findNativeRow: by order", { order, ri: s.dataset.rollIndex, lbl: labelOf(s) });
      return s;
    }

    if (rollIndex != null) {
      const strRI = String(rollIndex);
      const byRI = natives.find(s => (s.dataset.rollIndex ?? "") === strRI && (!rowLabel || labelOf(s) === rowLabel.toLowerCase()));
      if (byRI) {
        log("findNativeRow: by rollIndex(+label)", { rollIndex: strRI, lbl: rowLabel });
        return byRI;
      }
    }

    if (rowLabel) {
      const want = rowLabel.toLowerCase();
      const byLbl = natives.find(s => labelOf(s) === want);
      if (byLbl) {
        log("findNativeRow: by label", { lbl: rowLabel });
        return byLbl;
      }
    }

    warn("findNativeRow: fallback last", { natives: natives.length, rollIndex, rowLabel, order });
    return natives[natives.length - 1];
  }

  // Repair invalid rollIndex on section vs message.rolls
  function repairRollIndex(section, message, order) {
    const rolls = Array.isArray(message?.rolls) ? message.rolls : [];
    const maxIdx = Math.max(0, rolls.length - 1);
    const domRI = Number.parseInt(section.dataset.rollIndex ?? "0", 10);
    let useIdx = domRI;

    if (!Number.isFinite(useIdx) || useIdx < 0 || useIdx > maxIdx) {
      if (Number.isInteger(order) && order >= 0 && order <= maxIdx) useIdx = order;
      else useIdx = maxIdx;
    }

    if (String(useIdx) !== section.dataset.rollIndex) {
      warn("repairRollIndex", { domRI: section.dataset.rollIndex, rolls: rolls.length, order, useIdx });
      section.dataset.rollIndex = String(useIdx);
    }
    return useIdx;
  }

  // GM select tokens by UUID (optionally view scene), return restore()
  async function selectTokensForGM(targetUuids = []) {
    const tokens = targetUuids.map(u => {
      try { const d = fromUuidSync(u); return d?.object ?? null; } catch { return null; }
    }).filter(Boolean);

    if (!tokens.length) return { tokens: [], restore: async () => {} };

    const prev = {
      sceneId: canvas.scene?.id ?? null,
      controlledIds: canvas.tokens?.controlled?.map(t => t.id) ?? [],
      targets: new Set(game.user.targets)
    };

    const tgtScene = tokens[0]?.document?.parent;
    if (game.settings.get(MOD, "gmViewTargetScene") && tgtScene?.id && canvas.scene?.id !== tgtScene.id) {
      try { await tgtScene.view(); } catch {}
      await new Promise(r => setTimeout(r, 120));
    }

    try { canvas.tokens?.releaseAll?.(); } catch {}
    try { game.user.updateTokenTargets(new Set()); } catch {}
    tokens.forEach((t, i) => { try { t.control({ releaseOthers: i === 0 }); } catch {} });
    try { game.user.updateTokenTargets(new Set(tokens)); } catch {}

    const restore = async () => {
      try { canvas.tokens?.releaseAll?.(); } catch {}
      try { game.user.updateTokenTargets(new Set()); } catch {}
      for (const id of prev.controlledIds) {
        const tok = canvas.tokens?.get(id);
        if (tok) { try { tok.control({ releaseOthers: false }); } catch {} }
      }
      try { game.user.updateTokenTargets(prev.targets); } catch {}
      if (game.settings.get(MOD, "gmViewTargetScene") && prev.sceneId && canvas.scene?.id !== prev.sceneId) {
        const prevScene = game.scenes.get(prev.sceneId);
        if (prevScene) { try { await prevScene.view(); } catch {} }
      }
    };

    return { tokens, restore };
  }

  // ---------- GM queue ----------
  const GMQ = [];
  let GMQBusy = false;

  async function _runGMQueue() {
    if (GMQBusy) return;
    GMQBusy = true;
    try {
      while (GMQ.length) {
        const job = GMQ.shift();
        try {
          await gmApplyFromCardNow(job.payload);
        } catch (e) {
          console.error("[PDR] GMQ job failed", e);
          ui.notifications?.warn?.("PDR: a queued apply failed (see console).");
        }
        await new Promise(r => setTimeout(r, 75)); // stabilize PF2e listeners/DOM
      }
    } finally {
      GMQBusy = false;
    }
  }
  function enqueueGMApply(payload) {
    GMQ.push({ payload, at: Date.now() });
    _runGMQueue();
  }

  // ---------- GM apply (wrapped by queue) ----------
  async function gmApplyFromCardNow(payload) {
    try {
      const {
        messageId,
        rollIndex = null,
        rowLabel = "",
        order = null,
        application = "full",     // "full"|"half"|"double"|"healing"
        useBlock = false,
        targetUuids = []
      } = payload ?? {};

      const message = game.messages.get(messageId);
      if (!message) { warn("GM apply: message missing", payload); return; }

      await ensureCardInDOM(messageId);
      const li = document.querySelector(`li.chat-message[data-message-id="${messageId}"]`);
      if (!li) { warn("GM apply: li not found"); return; }

      const section = findNativeRow(li, { order, rollIndex, rowLabel });
      if (!section) { warn("GM apply: native section not found", { order, rollIndex, rowLabel }); return; }
      outline(section, "#22c55e");

      // ensure row points at a valid message roll (important for Splash)
      const fixedIdx = repairRollIndex(section, message, Number.isInteger(order) ? order : null);

      const { tokens, restore } = await selectTokensForGM(targetUuids);
      if (!tokens.length) { ui.notifications?.warn?.("PDR: No resolvable targets on GM side."); return; }

      // Optional suppression of PF2e feedback lines
      let suppressHandler = null;
      if (game.settings.get(MOD, "suppressSystemApplyMessage")) {
        const start = Date.now();
        suppressHandler = (msg) => {
          try {
            const f = msg?.flags?.pf2e;
            const isFeedback = f?.context?.type === "damage-taken";
            const recent = Date.now() - start < 1500;
            if (isFeedback && recent) msg.delete?.();
          } catch {}
        };
        Hooks.on("createChatMessage", suppressHandler);
      }

      try {
        if (useBlock) {
          const blockBtn = section.querySelector('button[data-action="shieldBlock"]');
          if (blockBtn) { try { blockBtn.dispatchEvent(new MouseEvent("click", { bubbles:true, cancelable:true })); } catch {} }
        }

        let mult = "1";
        if (application === "half") mult = "0.5";
        else if (application === "double") mult = "2";
        else if (application === "healing") mult = "-1";

        const applyBtn = section.querySelector(`button[data-action="applyDamage"][data-multiplier="${mult}"]`)
                       || section.querySelector('button[data-action="applyDamage"]');
        if (!applyBtn) { warn("GM apply: apply button not found for multiplier", mult); return; }

        log("GM clicking applyDamage", {
          rowLabel, domRI: section.dataset.rollIndex, fixedIdx, order,
          application, mult, targets: tokens.map(t => t.name),
          rollsCount: (message.rolls ?? []).length
        });
        outline(applyBtn, "#22c55e");
        applyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      } finally {
        setTimeout(() => { restore(); }, 350);
        if (suppressHandler) setTimeout(() => Hooks.off("createChatMessage", suppressHandler), 1500);
      }
    } catch (e) {
      err("GM apply error", e);
      ui.notifications?.error?.("PDR: apply failed (see console).");
    }
  }

  // Wrapper exposed to socket / queue toggle
  ns.gmApplyFromCard = (payload) => {
    if (!game.user.isGM) return;
    if (!game.settings.get(MOD, "serializeGM")) return gmApplyFromCardNow(payload);
    enqueueGMApply(payload);
  };

  // ---------- Player-side UI (replace-only) ----------
  function buildPdrRow(rollIndex, order, rowLabel, hasBlock, isHealing) {
    const row = document.createElement("section");
    row.className = "damage-application pdr-controls";
    if (rollIndex != null) row.dataset.rollIndex = String(rollIndex);
    row.dataset.rowLabel  = rowLabel;
    row.dataset.order     = String(order);

    if (isHealing) {
      row.innerHTML = `
        <button type="button" class="pdr-apply healing-only" data-app="healing"
          title="[Click] Apply full healing to selected tokens.&#10;[Shift-Click] Adjust value before applying.">
          <span class="fa-stack fa-fw">
            <i class="fa-solid fa-heart fa-stack-2x"></i>
            <i class="fa-solid fa-plus fa-inverse fa-stack-1x"></i>
          </span>
          <span class="label">${rowLabel}</span>
        </button>`;
      return row;
    }

    row.innerHTML = `
      <button type="button" class="pdr-apply" data-app="full"
        title="[Click] Apply full damage to selected tokens.&#10;[Shift-Click] Adjust value before applying.">
        <i class="fa-solid fa-heart-crack fa-fw"></i>
        <span class="label">${rowLabel}</span>
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
      ${hasBlock ? `
      <button type="button" class="pdr-block dice-total-shield-btn"
        title="[Click] Toggle the shield block status of the selected tokens before applying.">
        <i class="fa-solid fa-shield-blank fa-fw"></i>
        <span class="label">Block</span>
      </button>` : ``}`;
    return row;
  }

  function hideIndexRowsWithin(card, rollIndex, order) {
    // Hide our PDR row by order
    if (Number.isInteger(order)) {
      card.querySelectorAll(`section.damage-application.pdr-controls[data-order="${order}"]`)
          .forEach(el => el.style.display = "none");
    }
    // Hide the native row with matching rollIndex (visual parity)
    if (rollIndex != null) {
      card.querySelectorAll(`section.damage-application:not(.pdr-controls)[data-roll-index="${rollIndex}"]`)
          .forEach(el => el.style.display = "none");
    }
  }

  // Simplify persistent expressions in PF2e damage-taken lines
  function simplifyPersistentInHTML(message, htmlEl) {
    try {
      if (!game.settings.get(MOD, "simplifyPersistentMath")) return;
      const ctxType = message?.flags?.pf2e?.context?.type;
      if (ctxType !== "damage-taken") return;

      const list = htmlEl.querySelector(".damage-taken .persistent ul");
      if (!list) return;

      const items = Array.from(list.querySelectorAll("li"));
      for (const li of items) {
        const original = (li.textContent ?? "").trim();
        const m = original.match(/^\s*([0-9]+(?:\.[0-9]+)?)\s*(?:[*x×])\s*([0-9]+(?:\.[0-9]+)?)\s+(.*)$/i);
        if (!m) continue;
        const a = Number.parseFloat(m[1]);
        const b = Number.parseFloat(m[2]);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        const prod = a * b;
        const rounded = Number.isInteger(prod) ? String(Math.round(prod)) : String(prod);
        const rest = m[3]; // e.g., "persistent fire"
        if (DBG()) console.log("[PDR] simplify persistent:", { original, a, b, prod, rest });
        li.textContent = `${rounded} ${rest}`;
      }
    } catch (e) { warn("simplifyPersistentInHTML failed", e); }
  }

  ns.onRender = (message, htmlEl) => {
    try {
      if (game.system.id !== "pf2e") return;
      if (!message?.isContentVisible) return;
      if (!message?.flags?.pf2e) return;

      // Always try to simplify persistent math on damage-taken messages (if enabled)
      simplifyPersistentInHTML(message, htmlEl);

      // Replace only on cards that have native damage-application rows
      const card = htmlEl.closest("li.chat-message") || htmlEl;
      const natives = Array.from(htmlEl.querySelectorAll("section.damage-application:not(.pdr-controls)"));
      if (!natives.length) return;

      // Stable order across this card’s native rows
      const allNativesInCard = Array.from(card.querySelectorAll("section.damage-application:not(.pdr-controls)"));

      log("Render message", {
        msgId: message.id,
        rows: natives.map(sec => ({
          ri: sec.dataset.rollIndex ?? "?",
          order: allNativesInCard.indexOf(sec),
          hasBlock: nativeHasBlock(sec),
          healing: isHealingOnly(sec),
          label: nativePrimaryLabel(sec)
        }))
      });

      for (const native of natives) {
        const rollIndex = native.dataset.rollIndex ?? null;
        const order     = allNativesInCard.indexOf(native);
        const label     = nativePrimaryLabel(native);
        const hasBlock  = nativeHasBlock(native);
        const healing   = isHealingOnly(native);

        // Hide native and anchor our PDR row after it (one per native)
        native.style.display = "none";

        let row = native.nextElementSibling;
        const rowMatches = row && row.classList?.contains("pdr-controls")
                        && row.dataset.order === String(order);
        if (!rowMatches) {
          row = buildPdrRow(rollIndex, order, label, hasBlock, healing);
          native.insertAdjacentElement("afterend", row);
          outline(row);
          log("PDR row added", { messageId: message.id, rollIndex, order, label, hasBlock, healing });
        } else {
          // Keep label in sync
          row.dataset.rowLabel = label;
          const primary = row.querySelector('.pdr-apply .label');
          if (primary && primary.textContent !== label) primary.textContent = label;
        }

        if (row.dataset.pdrBound === "1") continue;
        row.dataset.pdrBound = "1";

        // Per-row Block toggle
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

          if (btn.classList.contains("pdr-block")) {
            blockOn = !blockOn;
            setBlockVisual();
            log("Toggle Block", { rollIndex, order, blockOn });
            return;
          }
          if (!btn.classList.contains("pdr-apply")) return;

          const application =
            btn.dataset.app ||
            (btn.classList.contains("healing-only") ? "healing" : "full");

          // Collect targets; self-fallback for healing
          let targetUuids = [...game.user.targets].map(t => t?.document?.uuid ?? t?.uuid).filter(Boolean);
          if (!targetUuids.length && application === "healing") {
            const sp = message?.speaker ?? {};
            if (sp.token && sp.scene) {
              const selfUuid = `Scene.${sp.scene}.Token.${sp.token}`;
              try { if (fromUuidSync(selfUuid)) targetUuids = [selfUuid]; } catch {}
            }
          }
          if (!targetUuids.length) { ui.notifications?.warn?.("PDR: No targets selected."); return; }

          const payload = {
            messageId: message.id,
            rollIndex: rollIndex != null ? String(rollIndex) : null,
            order, // preferred selector on GM
            rowLabel: row.dataset.rowLabel ?? label,
            application, // "full"|"half"|"double"|"healing"
            useBlock: !!blockOn,
            targetUuids
          };

          log("Route to GM", payload);
          outline(row, "#2563eb");

          try {
            if (game.user.isGM) {
              await gmApplyFromCardNow(payload);
            } else {
              if (!ns.socket) { ui.notifications?.error?.(`${MOD}: SocketLib not ready.`); return; }
              await ns.socket.executeAsGM(EVT, payload);
            }
          } catch (e) {
            err("route/apply failed", e);
            ui.notifications?.error?.("PDR: apply failed (see console).");
          } finally {
            hideIndexRowsWithin(card, rollIndex, order);
          }
        }, { once: false });
      }
    } catch (e) {
      err("renderChatMessageHTML error", e);
    }
  };
  Hooks.on("renderChatMessageHTML", ns.onRender);
})();
