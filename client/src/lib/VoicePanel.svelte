<script lang="ts">
  import { store } from "./authStore.svelte";
  import { gateway } from "./gateway.svelte";
  import { voice } from "./voice.svelte";
  import Avatar from "./Avatar.svelte";

  // The single seeded voice channel (or null if none seeded). Voice is a parallel control —
  // it is never routed through channelStore.select, so the message pane is unaffected.
  const channel = $derived(gateway.voiceChannels[0] ?? null);
  const inVoice = $derived(voice.voiceChannelId !== null);
  const joining = $derived(voice.status === "joining");
  const selfId = $derived(store.currentUser?.id ?? null);
  const selfName = $derived(store.currentUser?.username ?? "you");
  const selfAvatarId = $derived(store.currentUser?.avatarId ?? null);

  // Audio level above which we ring a participant's avatar to show they're talking.
  // The same normalized 0–1 level drives the meter fill, so the ring and bar agree.
  const SPEAKING_THRESHOLD = 0.12;
  // A muted mic still produces no signal, but guard anyway so we never light our own
  // ring while muted.
  const selfSpeaking = $derived(!voice.muted && voice.localLevel > SPEAKING_THRESHOLD);

  const memberById = $derived(new Map(gateway.members.map((m) => [m.id, m])));

  function participantName(userId: number | null, fallback: string): string {
    if (userId === null) return fallback;
    const m = memberById.get(userId);
    return m?.displayName ?? m?.username ?? fallback;
  }

  // The avatar for a participant, resolved from the member list. Null (unknown user or
  // no picture) makes Avatar fall back to the name initial, matching the members list.
  function participantAvatarId(userId: number | null): number | null {
    if (userId === null) return null;
    return memberById.get(userId)?.avatarId ?? null;
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
          <span class="avatar-ring" class:speaking={selfSpeaking}>
            <Avatar avatarId={selfAvatarId} name={selfName} size={28} />
          </span>
          <span class="name">{selfName} (you)</span>
          {#if voice.muted}<span class="muted-marker" title="Muted">🔇</span>{/if}
          <span class="meter" title="Mic input level">
            <span class="meter-fill" style:width={`${Math.round(voice.localLevel * 100)}%`}></span>
          </span>
        </li>
        {#each voice.participants as p (p.participantId)}
          {@const name = participantName(p.userId, p.participantId)}
          <li class="member">
            <span class="avatar-ring" class:speaking={voice.levelFor(p.participantId) > SPEAKING_THRESHOLD}>
              <Avatar avatarId={participantAvatarId(p.userId)} {name} size={28} />
            </span>
            <span class="name">{name}</span>
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
  /* Avatar with a "speaking" ring: a transparent outline by default that lights up
     green the moment the participant's audio level crosses SPEAKING_THRESHOLD. The
     transition softens the on/off so brief level dips don't look like flicker. */
  .avatar-ring {
    flex: none;
    display: block;
    line-height: 0;
    border-radius: 50%;
    box-shadow: 0 0 0 2px transparent;
    transition: box-shadow 90ms ease;
  }
  .avatar-ring.speaking {
    box-shadow: 0 0 0 2px var(--ok);
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
