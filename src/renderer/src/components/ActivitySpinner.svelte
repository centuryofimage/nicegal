<span class="activity-spinner" aria-hidden="true"></span>

<style>
  .activity-spinner {
    display: inline-block;
    flex: none;
    width: 6px;
    height: 6px;
    border: 1px solid var(--accent);
    border-top-color: transparent;
    border-radius: 50%;
    animation: activity-spin 850ms linear infinite;
  }

  @keyframes activity-spin {
    to {
      transform: rotate(1turn);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .activity-spinner {
      border-top-color: var(--accent);
      background: var(--accent);
      animation: none;
    }
  }
</style>
