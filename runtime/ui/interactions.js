(function () {
function bindInteractions(ctx) {
  const {
    $,
    state,
    selectedTopic,
    selectedRound,
    visibleRounds,
    selectFirstVisibleRound,
    render,
    refreshProductionData,
    updateLiveControls,
    kbdGuard,
  } = ctx;
  
  document.addEventListener("click", (event) => {
    const topic = event.target.closest("[data-topic]");
    if (topic) {
      state.selectedTopic = topic.dataset.topic;
      selectFirstVisibleRound(selectedTopic());
      render();
      void refreshProductionData({ preserve: false, scrollSelected: true });
      return;
    }
    const round = event.target.closest("[data-round]");
    if (round) {
      state.selectedRound = Number(round.dataset.round);
      render();
      return;
    }
    const project = event.target.closest("[data-project]");
    if (project) {
      state.selectedProject = project.dataset.project;
      localStorage.setItem("handoff:selectedProject", state.selectedProject);
      state.selectedTopic = "";
      selectFirstVisibleRound(selectedTopic());
      render({ scrollSelected: true });
    }
  });
  
  $("#search").addEventListener("input", (event) => {
    state.query = event.target.value;
    selectFirstVisibleRound(selectedTopic());
    render();
  });

  $("#workspace-select")?.addEventListener("change", (event) => {
    state.selectedProject = event.target.value;
    localStorage.setItem("handoff:selectedProject", state.selectedProject);
    state.selectedTopic = "";
    selectFirstVisibleRound(selectedTopic());
    render({ scrollSelected: true });
  });
  
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement !== $("#search") && !kbdGuard(event)) {
      event.preventDefault();
      $("#search").focus();
      return;
    }
    if (event.key === "Escape") {
      if (document.activeElement === $("#search")) {
        event.preventDefault();
        $("#search").blur();
        if (state.query) {
          state.query = "";
          $("#search").value = "";
          selectFirstVisibleRound(selectedTopic());
          render();
        }
        return;
      }
      return;
    }
    if (["j", "k"].includes(event.key) && !kbdGuard(event)) {
      const topic = selectedTopic();
      const rounds = visibleRounds(topic);
      if (!rounds.length) return;
      const currentIndex = rounds.findIndex((round) => round.index === state.selectedRound);
      const safeIndex = currentIndex < 0 ? 0 : currentIndex;
      const nextIndex = event.key === "j"
        ? Math.min(rounds.length - 1, safeIndex + 1)
        : Math.max(0, safeIndex - 1);
      state.selectedRound = rounds[nextIndex].index;
      render();
      return;
    }
    if (["[", "]"].includes(event.key) && !kbdGuard(event)) {
      const topic = selectedTopic();
      const current = selectedRound(topic);
      if (!current) return;
      const lane = visibleRounds(topic).filter((round) => round.agent === current.agent);
      const currentIndex = lane.findIndex((round) => round.index === current.index);
      if (currentIndex < 0) return;
      const nextIndex = event.key === "]"
        ? Math.min(lane.length - 1, currentIndex + 1)
        : Math.max(0, currentIndex - 1);
      state.selectedRound = lane[nextIndex].index;
      render();
      return;
    }
    if (event.key === "G" && !kbdGuard(event)) {
      const rounds = visibleRounds(selectedTopic());
      state.selectedRound = rounds.at(-1)?.index ?? null;
      render();
      return;
    }
    if (event.key === "g" && !kbdGuard(event)) {
      const rounds = visibleRounds(selectedTopic());
      state.selectedRound = rounds[0]?.index ?? null;
      render();
      return;
    }
  });
  
  document.addEventListener("visibilitychange", () => {
    updateLiveControls();
  });
}

window.RelayUiInteractions = { bindInteractions };
})();
