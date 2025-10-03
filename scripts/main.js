/* Player Damage Router — PF2e Button Integrator (v1.3.7-heal)
 * - Handles PF2e damage rows and healing-only rows
 * - Replace (default) or Integrate
 * - Robust multi-row routing (main/splash/persistent/heal)
 * - GM recomputes true roll-index before clicking to avoid splash mismatch
 * - PF2e 7.5.2 • Foundry v13+ (renderChatMessageHTML)
 */
(() => {
  const MOD   = "player-damage-router";
  const EVT   = "PDR_APPLY_PF2E_BUTTON";
  const VER   = "1.3.7-heal";
  const DEBUG = false;
  const log = (...a) => DEBUG && console.log(`[${MOD}]`, ...a);

  const ns = (globalThis.PDR ??= {});
  try { ns.dispose?.(); } catch {}
  ns.dispose = () => {
    try { Hooks.off("renderChatMessageHTML", ns.onRender); } catch {}
    try { Hooks.off("createChatMessage", ns.onChatCreate); } catch {}
    ns.onRender = null; ns.onChatCreate = null;
  };

  // ---------------- Settings ----------------
  Hooks.once("init", () => {
    game.settings.register(MOD, "autoDeleteWhispers", {
      name: "Auto-delete routing whispers (GM)",
      hint: "Delete the GM-only whisper that carries the apply request after processing.",
      scope: "world", config: true, type: Boolean, default: true
    });
    game.settings.register(MOD, "integrationMode", {
      name: "Button Integration Mode",
      hint: "Integrate = hook PF2e buttons in place. Replace = hide PF2e buttons and render PDR buttons instead.",
      scope: "world", config: true, type: String, choices: {
        integrate: "Integrate (hook PF2e buttons)",
        replace:   "Replace (hide PF2e buttons, show PDR row)"
      }, default: "replace"
    });
    game.settings.register(MOD, "suppressGmToasts", {
      name: "Suppress GM pop-ups",
      hint: "If enabled, GM will not see notifications when routing.",
      scope: "client", config: true, type: Boolean, default: true
    });
    game.settings.register(MOD, "postGmSummary", {
      name: "Post GM summary to chat",
      hint: "If enabled, GM posts a short summary message after applying.",
      scope: "world", config: true, type: Boolean, default: false
    });
    game.settings.register(MOD, "gmViewTargetScene", {
      name: "GM: Auto-view target scene when applying",
      hint: "Temporarily switch GM to the scene holding the player’s targets, then restore.",
      scope: "world", config: true, type: Boolean, default: true
    });
  });

  // ---------------- Ready: GM whisper handler ----------------
  Hooks.once("ready", () => {
    log(`ready v${VER}; isGM=${game.user.isGM}`);

    if (game.user.isGM) {
      ns.onChatCreate = async (msg) => {
        const f = msg?.flags?.[MOD];
        if (!f || f.evt !== EVT) return;
        try {
          await gmApplyFromCard(f);
        } catch (e) {
          console.error(`[${MOD}] GM handler error`, e);
          if (!game.settings.get(MOD, "suppressGmToasts")) ui.notifications?.error("PDR: apply failed.");
        } finally {
          if (game.settings.get(MOD, "autoDeleteWhispers")) {
            try { await msg?.delete?.(); } catch (_) {}
          }
        }
      };
      Hooks.on("createChatMessage", ns.onChatCreate);
    }
  });

  // ---------- GM helpers ----------
  async function PDR_selectTokensForGM(targetUuids = []) {
    const tokens = targetUuids.map(u => {
      try { const d = fromUuidSync(u); return d?.object ?? null; } catch { return null; }
    }).filter(Boolean);

    const noop = async () => {};
    if (!tokens.length) return { tokens: [], restore: noop };

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
    tokens.forEach((t, i) => { try { t.control({ releaseOthers: i === 0 }); } catch {} });
    try { game.user.updateTokenTargets(new Set(tokens)); } catch {}

    const restore = async () => {
      try { canvas.tokens?.releaseAll?.(); } catch {}
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

  function listNativeRows(li) {
    return Array.from(li.querySelectorAll('section.damage-application:not(.pdr-controls)'));
  }

  // Recompute the *true* roll index for this section by finding its preceding dice-roll
  function recomputeRollIndexForSection(section, li) {
    const allRolls = Array.from(li.querySelectorAll('section.dice-roll.damage-roll'));
    let prev = section.previousElementSibling;
    while (prev && !prev.matches?.('section.dice-roll.damage-roll')) {
      prev = prev.previousElementSibling;
    }
    const idx = prev ? allRolls.indexOf(prev) : -1;
    if (DEBUG) log("recompute idx:", { idx, prev, allRolls });
    return idx >= 0 ? String(idx) : (section.dataset.rollIndex ?? "0");
  }

  // ---- GM: apply (prefers ORDINAL, falls back to rollIndex); fix index before click ----
  async function gmApplyFromCard(flag) {
    const { messageId, rollIndex = "0", ordinal = null, application = "full", useBlock = false, targetUuids = [] } = flag;
    const message = game.messages.get(messageId);
    if (!message) return;

    await ensureCardInDOM(messageId);
    const li = document.querySelector(`li.chat-message[data-message-id="${messageId}"]`);
    if (!li) return;

    const natives = listNativeRows(li);
    const hasOrd = Number.isInteger(ordinal);
    let section = (hasOrd && natives[ordinal]) ||
                  li.querySelector(`section.damage-application[data-roll-index="${rollIndex}"]:not(.pdr-controls)`) ||
                  natives[0];
    if (!section) return;

    // Force a correct rollIndex on the section before clicking
    const corrected = recomputeRollIndexForSection(section, li);
    section.dataset.rollIndex = corrected;

    const { tokens, restore } = await PDR_selectTokensForGM(targetUuids);
    if (!tokens.length) {
      ui.notifications?.warn("PDR: No resolvable targets on GM side.");
      return;
    }

    try {
      // Only block for damage rows; heal rows lack block
      if (useBlock && !isHealingSection(section)) {
        const blockBtn = section.querySelector('button[data-action="shieldBlock"]');
        if (blockBtn) { try { blockBtn.click(); } catch {} }
      }

      const mult =
        application === "healing" ? "-1" :
        application === "half"    ? "0.5" :
        application === "double"  ? "2"   : "1";

      const applyBtn = section.querySelector(`button[data-action="applyDamage"][data-multiplier="${mult}"]`)
                     || section.querySelector('button[data-action="applyDamage"]');
      if (!applyBtn) return;

      applyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    } finally {
      setTimeout(() => { restore(); }, 350);
    }

    if (game.settings.get(MOD, "postGmSummary")) {
      ChatMessage.create({
        speaker: { alias: "PDR" },
        content: `<small>Applied <b>${application}</b> from card ${messageId} (ord ${hasOrd ? ordinal : "?"}, idx ${section.dataset.rollIndex}) to ${tokens.length} target(s).${useBlock && application!=="healing" ? " [Block]" : ""}</small>`
      });
    }
  }

  function isHealingSection(section) {
    return !!section.querySelector('button.healing-only, button[data-action="applyDamage"][data-multiplier="-1"]');
  }

  async function ensureCardInDOM(messageId) {
    if (document.querySelector(`li.chat-message[data-message-id="${messageId}"]`)) return;
    try { await ui.chat?.render?.(true); } catch {}
  }

  // ---------- Player utilities ----------
  function closestNativeRowBefore(el) {
    let n = el?.previousElementSibling ?? null;
    while (n) {
      if (n.matches?.('section.damage-application:not(.pdr-controls)')) return n;
      n = n.previousElementSibling;
    }
    const card = el?.closest?.("li.chat-message");
    return card?.querySelector?.('section.damage-application:not(.pdr-controls)') ?? null;
  }

  function computeOrdinal(nativeRow) {
    const card = nativeRow?.closest?.("li.chat-message");
    const list = card ? Array.from(card.querySelectorAll('section.damage-application:not(.pdr-controls)')) : [];
    return list.indexOf(nativeRow);
  }

  function hideThisPair(rowOrNative) {
    const native = rowOrNative.classList.contains("pdr-controls")
      ? closestNativeRowBefore(rowOrNative)
      : rowOrNative;
    const pdr = native?.nextElementSibling?.classList?.contains("pdr-controls")
      ? native.nextElementSibling
      : null;
    if (native) native.style.display = "none";
    if (pdr) pdr.style.display = "none";
  }

  // ---------- Player: render ----------
  ns.onRender = (message, htmlEl) => {
    try {
      if (game.system.id !== "pf2e") return;
      if (!message?.isContentVisible) return;
      if (!message?.flags?.pf2e) return;

      const nativeSections = Array.from(htmlEl.querySelectorAll('section.damage-application:not(.pdr-controls)'));
      if (!nativeSections.length) return;

      const mode = game.settings.get(MOD, "integrationMode");

      for (const section of nativeSections) {
        const initialIndex = section.dataset.rollIndex ?? "0";
        const isHeal = isHealingSection(section);

        if (mode === "replace") {
          // Keep native in DOM as anchor, but hide visually
          section.style.display = "none";

          if (!section.nextElementSibling || !section.nextElementSibling.classList?.contains("pdr-controls")) {
            const hasBlock = !isHeal && !!section.querySelector('button[data-action="shieldBlock"]');

            const row = document.createElement("section");
            row.className = "damage-application pdr-controls";
            row.dataset.rollIndex = initialIndex;

            if (isHeal) {
              // Healing-only lookalike (PF2e style)
              row.innerHTML = `
                <button type="button" class="pdr-heal healing-only" data-app="healing" title="[Click] Apply full healing to selected tokens.&#10;[Shift-Click] Adjust value before applying.">
                  <span class="fa-stack fa-fw">
                    <i class="fa-solid fa-heart fa-stack-2x"></i>
                    <i class="fa-solid fa-plus fa-inverse fa-stack-1x"></i>
                  </span>
                  <span class="label">Apply Healing</span>
                </button>
              `;
            } else {
              // Damage lookalike row
              row.innerHTML = `
                <button type="button" class="pdr-apply" data-app="full" title="[Click] Apply full damage to selected tokens.&#10;[Shift-Click] Adjust value before applying.">
                  <i class="fa-solid fa-heart-crack fa-fw"></i>
                  <span class="label">Damage</span>
                </button>
                <button type="button" class="pdr-apply half-damage" data-app="half" title="[Click] Apply half damage to selected tokens.&#10;[Shift-Click] Adjust value before applying.">
                  <i class="fa-solid fa-heart-crack fa-fw"></i>
                  <span class="label">Half</span>
                </button>
                <button type="button" class="pdr-apply" data-app="double" title="[Click] Apply double damage to selected tokens.&#10;[Shift-Click] Adjust value before applying.">
                  <img src="systems/pf2e/icons/damage/double.svg">
                  <span class="label">Double</span>
                </button>
                ${hasBlock ? `
                <button type="button" class="pdr-block dice-total-shield-btn" title="[Click] Toggle the shield block status of the selected tokens before applying damage.">
                  <i class="fa-solid fa-shield-blank fa-fw"></i>
                  <span class="label">Block</span>
                </button>` : ``}
              `;
            }

            section.insertAdjacentElement("afterend", row);

            let blockOn = false;
            const blockBtn = row.querySelector(".pdr-block");
            const setBlockVisual = () => {
              if (!blockBtn) return;
              blockBtn.setAttribute("aria-pressed", blockOn ? "true" : "false");
              blockBtn.classList.toggle("active", !!blockOn);
              if (blockBtn.style) blockBtn.style.opacity = blockOn ? "1" : "0.75";
            };
            setBlockVisual();

            row.addEventListener("click", (ev) => {
              const btn = ev.target.closest("button");
              if (!btn) return;

              const native = closestNativeRowBefore(row) || section;
              const rollIndex = native?.dataset?.rollIndex ?? initialIndex;
              const ordinal = computeOrdinal(native);

              if (!isHeal && btn.classList.contains("pdr-block")) {
                blockOn = !blockOn;
                setBlockVisual();
                return;
              }

              if (game.user.isGM) return;

              if (isHeal && btn.classList.contains("pdr-heal")) {
                sendRequest(message, "healing", { rollIndex, ordinal, useBlock: false });
                hideThisPair(row);
                return;
              }

              if (!isHeal && btn.classList.contains("pdr-apply")) {
                const application = btn.dataset.app; // "full"|"half"|"double"
                sendRequest(message, application, { rollIndex, ordinal, useBlock: blockOn });
                hideThisPair(row);
              }
            });
          }
        } else {
          // INTEGRATE: intercept native apply buttons inside THIS native section
          section.addEventListener("click", (ev) => {
            const btn = ev.target.closest('button[data-action="applyDamage"]');
            if (!btn) return;
            if (game.user.isGM) return;

            ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();

            const mult = String(btn.dataset.multiplier ?? "1");
            const application =
              mult === "-1" ? "healing" :
              mult === "0.5" ? "half" :
              mult === "2"   ? "double" : "full";

            const rollIndex = section.dataset.rollIndex ?? "0";
            const ordinal = computeOrdinal(section);

            sendRequest(message, application, { rollIndex, ordinal, useBlock: false });
            hideThisPair(section);
          }, { capture: true });
        }
      }
    } catch (e) {
      console.error(`${MOD} | renderChatMessageHTML error`, e);
    }
  };
  Hooks.on("renderChatMessageHTML", ns.onRender);

  // ---------- Player → GM (whisper) ----------
  async function sendRequest(message, application, extra = {}) {
    const gmIds = game.users.filter(u => u.isGM).map(u => u.id);
    if (!gmIds.length) return ui.notifications?.error("PDR: No GM online.");

    const targetUuids = [...game.user.targets].map(t => t?.document?.uuid ?? t?.uuid).filter(Boolean);
    if (!targetUuids.length) return ui.notifications?.warn("PDR: No targets selected.");

    const payload = {
      evt: EVT,
      messageId: message.id,
      application,                  // "full" | "half" | "double" | "healing"
      rollIndex: String(extra.rollIndex ?? "0"),
      ordinal: Number.isInteger(extra.ordinal) ? extra.ordinal : null,
      useBlock: !!extra.useBlock,   // ignored for healing
      targetUuids,
      playerId: game.user.id,
      at: Date.now()
    };

    await ChatMessage.create({
      whisper: gmIds,
      speaker: { alias: "PDR" },
      content: `<small>Routing ${application}${payload.useBlock && application!=="healing" ? " [Block]" : ""} from card ${message.id} (ord ${payload.ordinal ?? "?"}, idx ${payload.rollIndex}) to ${targetUuids.length} target(s)…</small>`,
      flags: { [MOD]: { ...payload, autoDelete: game.settings.get(MOD, "autoDeleteWhispers") } }
    });
  }
})();
