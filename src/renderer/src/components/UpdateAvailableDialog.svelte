<script lang="ts">
  import type { ReleaseNoteSegment } from "../../../shared/updates";

  import { m } from "../../../shared/paraglide/messages.js";
  import Modal from "./Modal.svelte";

  let {
    version,
    notes,
    installReady,
    onclose,
    onnotes,
    onrestart,
  }: {
    version: string | null;
    /** Changelog bullets from the release notes. */
    notes: ReleaseNoteSegment[][];
    installReady: boolean;
    onclose: () => void;
    onnotes: () => Promise<void>;
    onrestart: () => Promise<void>;
  } = $props();

  let restarting = $state(false);
  let error = $state<string | null>(null);

  const body = $derived.by(() => {
    if (installReady)
      return version
        ? m.update_dialog_ready_body({ version })
        : m.update_dialog_ready_body_unversioned();
    return version
      ? m.update_dialog_available_body({ version })
      : m.update_dialog_available_body_unversioned();
  });

  async function openNotes(): Promise<void> {
    error = null;
    try {
      await onnotes();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function openLink(event: MouseEvent & { currentTarget: HTMLAnchorElement }): Promise<void> {
    event.preventDefault();
    error = null;
    try {
      await window.nicegal.native.openExternalUrl(event.currentTarget.href);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function restart(): Promise<void> {
    error = null;
    restarting = true;
    try {
      await onrestart();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      restarting = false;
    }
  }
</script>

<Modal
  labelledby="update-dialog-title"
  describedby="update-dialog-description"
  {onclose}
  --modal-width="410px"
>
  <section class="dialog-panel">
    <h1 id="update-dialog-title">{m.common_update_available()}</h1>
    <p id="update-dialog-description">{body}</p>
    {#if notes.length > 0}
      <ul class="update-notes" aria-label={m.update_dialog_changes_aria()}>
        {#each notes as note, index (index)}<li>
            {#each note as segment, part (part)}{#if segment.href}<a
                  href={segment.href}
                  onclick={openLink}>{segment.text}</a
                >{:else}{segment.text}{/if}{/each}
          </li>{/each}
      </ul>
    {/if}
    {#if error}<p class="dialog-error" role="alert">{error}</p>{/if}
    <footer class="dialog-footer">
      <button class="ui-button ui-button-compact" onclick={openNotes} disabled={restarting}
        >{installReady
          ? m.update_dialog_release_notes_button()
          : m.update_dialog_open_release_page_button()}</button
      >
      <button class="ui-button ui-button-compact" onclick={onclose} disabled={restarting}
        >{m.update_dialog_later_button()}</button
      >
      {#if installReady}
        <button
          class="ui-button ui-button-compact ui-button-primary"
          onclick={restart}
          disabled={restarting}
        >
          {restarting ? m.update_dialog_restarting_button() : m.update_dialog_restart_button()}
        </button>
      {/if}
    </footer>
  </section>
</Modal>

<style>
  .update-notes {
    max-height: 160px;
    margin: 0;
    padding-left: var(--space-16);
    overflow-y: auto;
    line-height: var(--line-height-normal);
  }
</style>
