<script lang="ts">
  import { store } from "./authStore.svelte";
  import { gateway } from "./gateway.svelte";
  import { voice } from "./voice.svelte";

  // The single seeded voice channel (or null if none seeded). Voice is a parallel control —
  // it is never routed through channelStore.select, so the message pane is unaffected.
  const channel = $derived(gateway.voiceChannels[0] ?? null);
  const inVoice = $derived(voice.voiceChannelId !== null);
  const joining = $derived(voice.status === "joining");
  const selfId = $derived(store.currentUser?.id ?? null);
  const selfName = $derived(store.currentUser?.username ?? "you");

  const memberById = $derived(new Map(gateway.members.map((m) => [m.id, m])));

  function participantName(userId: number | null, fallback: string): string {
    if (userId === null) return fallback;
    const m = memberById.get(userId);
    return m?.displayName ?? m?.username ?? fallback;
  }
</script>

{#if channel !== null}
  <div class="voice-card">
    <div class="voice-channel">
      <span class="glyph" aria-hidden="true">🔊</span>
      <span class="vname">{channel.name}</span>
    </div>

    <div class="controls">
      {#if inVoice}
        <button type="button" class="leave" onclick={() => voice.leave()}>Leave</button>
        <button type="button" class="toggle" class:active={voice.muted} onclick={() => voice.toggleMute()}>
          {voice.muted ? "Unmute" : "Mute"}
        </button>
        <button
          type="button"
          class="toggle"
          class:active={voice.deafened}
          onclick={() => voice.toggleDeafen()}
        >
          {voice.deafened ? "Undeafen" : "Deafen"}
        </button>
      {:else}
        <button type="button" class="join" disabled={joining} onclick={() => voice.join(channel.id)}>
          {joining ? "Joining…" : "Join"}
        </button>
      {/if}
    </div>

    {#if inVoice && voice.audioBlocked}
      <button type="button" class="enable-audio" onclick={() => voice.enableAudio()}>
        🔈 Tap to enable audio
      </button>
    {/if}

    {#if inVoice}
      <ul class="in-voice">
        <li class="member">
          <span class="dot online"></span>
          <span class="name">{selfName} (you)</span>
          {#if voice.muted}<span class="muted-marker" title="Muted">🔇</span>{/if}
          <span class="meter" title="Mic input level">
            <span class="meter-fill" style:width={`${Math.round(voice.localLevel * 100)}%`}></span>
          </span>
        </li>
        {#each voice.participants as p (p.participantId)}
          <li class="member">
            <span class="dot online"></span>
            <span class="name">{participantName(p.userId, p.participantId)}</span>
            {#if p.muted}<span class="muted-marker" title="Muted">🔇</span>{/if}
            <span class="meter" title="Incoming audio level">
              <span
                class="meter-fill"
                style:width={`${Math.round(voice.levelFor(p.participantId) * 100)}%`}
              ></span>
            </span>
          </li>
        {/each}
      </ul>
    {/if}

    {#if voice.error}
      <p class="err">{voice.error}</p>
    {/if}
  </div>
{/if}

<style>
  .voice-card {
    display: flex;
    flex-direction: column;
  }
  .voice-channel {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.5rem;
    color: var(--text);
    font-weight: 500;
  }
  .glyph {
    flex: none;
  }
  .controls {
    display: flex;
    gap: 0.5rem;
    margin: 0.5rem 0;
  }
  .toggle {
    background: none;
    color: var(--muted);
  }
  .toggle:hover {
    color: var(--text);
  }
  .toggle.active {
    background: var(--accent);
    color: var(--text);
  }
  .in-voice {
    list-style: none;
    margin: 0.25rem 0 0;
    padding: 0;
  }
  .member {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.4rem 0;
  }
  .dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    flex: none;
  }
  .dot.online {
    background: var(--ok);
  }
  .name {
    color: var(--text);
  }
  .muted-marker {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .meter {
    margin-left: auto;
    width: 3.5rem;
    height: 0.4rem;
    border-radius: 0.2rem;
    background: var(--bg-elevated, rgba(255, 255, 255, 0.08));
    overflow: hidden;
    flex: none;
  }
  .meter-fill {
    display: block;
    height: 100%;
    width: 0;
    background: var(--ok);
    transition: width 60ms linear;
  }
  .enable-audio {
    margin: 0.4rem 0 0;
    background: var(--accent);
    color: var(--text);
    font-weight: 500;
  }
  .err {
    color: var(--err, #f87171);
    font-size: 0.85rem;
    margin: 0.4rem 0 0;
  }
</style>
