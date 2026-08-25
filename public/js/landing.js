(function () {
  const socket = io({ autoConnect: true });

  const createBtn = document.getElementById('create-btn');
  const createName = document.getElementById('create-name');
  const joinBtn = document.getElementById('join-btn');
  const joinCode = document.getElementById('join-code');
  const joinName = document.getElementById('join-name');
  const joinError = document.getElementById('join-error');

  function storeIdentityAndGo(code, name) {
    sessionStorage.setItem('watchwithisha:name', name || 'Guest');
    window.location.href = `/room.html?code=${encodeURIComponent(code)}`;
  }

  createBtn.addEventListener('click', () => {
    createBtn.disabled = true;
    createBtn.textContent = 'Creating…';
    const name = createName.value.trim();
    socket.emit('create-room', { name }, (res) => {
      createBtn.disabled = false;
      createBtn.textContent = 'Start a room';
      if (res && res.ok) {
        storeIdentityAndGo(res.code, name);
      }
    });
  });

  function attemptJoin() {
    const code = joinCode.value.trim().toUpperCase();
    const name = joinName.value.trim();
    joinError.textContent = '';
    if (code.length < 4) {
      joinError.textContent = 'Enter the room code you were given.';
      return;
    }
    joinBtn.disabled = true;
    joinBtn.textContent = 'Joining…';
    socket.emit('join-room', { code, name }, (res) => {
      joinBtn.disabled = false;
      joinBtn.textContent = 'Join room';
      if (res && res.ok) {
        storeIdentityAndGo(code, name);
      } else {
        joinError.textContent = 'No room found with that code.';
      }
    });
  }

  joinBtn.addEventListener('click', attemptJoin);
  joinCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptJoin(); });
  joinName.addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptJoin(); });
  joinCode.addEventListener('input', () => {
    joinCode.value = joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  // Pre-fill code from a shared link like /?code=ABC123
  const params = new URLSearchParams(window.location.search);
  if (params.get('code')) joinCode.value = params.get('code').toUpperCase();
})();
