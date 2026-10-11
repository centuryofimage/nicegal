<script lang="ts">
  import { m } from "../../../shared/paraglide/messages.js";
  import Modal from "./Modal.svelte";

  let { onclose }: { onclose: () => void } = $props();

  let restarting = $state(false);
  let error = $state<string | null>(null);

  async function restart(): Promise<void> {
    error = null;
    restarting = true;
    try {
      await window.nicegal.language.restart();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      restarting = false;
    }
  }
</script>

<Modal
  labelledby="language-restart-title"
  describedby="language-restart-description"
  {onclose}
  --modal-width="380px"
>
  <section class="dialog-panel">
    <h1 id="language-restart-title">{m.language_restart_title()}</h1>
    <p id="language-restart-description">{m.language_restart_body()}</p>
    {#if error}<p class="dialog-error" role="alert">{error}</p>{/if}
    <footer class="dialog-footer">
      <button class="ui-button ui-button-compact" onclick={onclose} disabled={restarting}
        >{m.language_restart_later()}</button
      >
      <button
        class="ui-button ui-button-compact ui-button-primary"
        onclick={restart}
        disabled={restarting}
        >{restarting ? m.language_restarting() : m.language_restart_now()}</button
      >
    </footer>
  </section>
</Modal>
