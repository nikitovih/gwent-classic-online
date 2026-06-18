"use strict";

// Helper function to shuffle an array
function shuffleArray(array) {
	for (let i = array.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[array[i], array[j]] = [array[j], array[i]];
	}
}

// Passive remote player controller that waits for network actions
class ControllerOnline {
	constructor(player) {
		this.player = player;
	}
	async startTurn(player) {
		// Do nothing, wait for remote player to send action
	}
	redraw() {
		// Do nothing, hand swap is handled via REDRAW network message
	}
}

// Helper: find a card by its uid in a container (hand, deck, grave, row)
function findCardByUid(container, uid) {
	if (!container || !container.cards) return null;
	return container.cards.find(c => c.uid === uid) || null;
}

// Helper: search globally for a card by its UID
function findCardByUidGlobal(uid) {
	if (typeof player_me !== 'undefined' && player_me && player_me.leader && player_me.leader.uid === uid) return player_me.leader;
	if (typeof player_op !== 'undefined' && player_op && player_op.leader && player_op.leader.uid === uid) return player_op.leader;
	
	const containers = [];
	if (typeof player_me !== 'undefined' && player_me) {
		containers.push(player_me.hand, player_me.deck, player_me.grave);
	}
	if (typeof player_op !== 'undefined' && player_op) {
		containers.push(player_op.hand, player_op.deck, player_op.grave);
	}
	if (typeof weather !== 'undefined' && weather) {
		containers.push(weather);
	}
	if (typeof board !== 'undefined' && board && board.row) {
		board.row.forEach(r => containers.push(r));
	}
	
	for (let container of containers) {
		if (container && container.cards) {
			let card = container.cards.find(c => c.uid === uid);
			if (card) return card;
		}
	}
	return null;
}

// Helper: search globally for a card by its name
function findCardByNameGlobal(name, owner) {
	const players = [];
	if (owner) {
		players.push(owner, owner.opponent());
	} else {
		if (typeof player_me !== 'undefined' && player_me) players.push(player_me);
		if (typeof player_op !== 'undefined' && player_op) players.push(player_op);
	}
	
	for (let player of players) {
		if (!player) continue;
		const containers = [player.hand, player.deck, player.grave];
		for (let container of containers) {
			if (container && container.cards) {
				let card = container.cards.find(c => c.name === name);
				if (card) return card;
			}
		}
	}
	
	if (typeof board !== 'undefined' && board && board.row) {
		for (let row of board.row) {
			let card = row.cards.find(c => c.name === name);
			if (card) return card;
		}
	}
	
	if (typeof weather !== 'undefined' && weather && weather.cards) {
		let card = weather.cards.find(c => c.name === name);
		if (card) return card;
	}
	return null;
}

// Helper: look up a card by UID with name verification and container/global fallbacks
function getCardByUidWithNameFallback(uid, name, container, owner) {
	if (!container || !container.cards) {
		let card = findCardByUidGlobal(uid);
		if (card && card.name === name) return card;
		return findCardByNameGlobal(name, owner);
	}
	
	// 1. Search container by UID
	let card = container.cards.find(c => c.uid === uid);
	if (card) {
		if (card.name === name) {
			return card;
		} else {
			console.warn(`Card mismatch: UID ${uid} in container is ${card.name} but expected ${name}.`);
		}
	}
	
	// 2. Search container by name
	card = container.cards.find(c => c.name === name);
	if (card) {
		console.warn(`Fallback: found card by name "${name}" in container instead of UID ${uid}.`);
		return card;
	}
	
	// 3. Search globally by UID
	card = findCardByUidGlobal(uid);
	if (card && card.name === name) {
		console.warn(`Fallback: found card by UID ${uid} globally instead of in container.`);
		return card;
	}
	
	// 4. Search globally by name
	card = findCardByNameGlobal(name, owner);
	if (card) {
		console.warn(`Fallback: found card by name "${name}" globally.`);
		return card;
	}
	
	// Last resort: return first card in container
	if (container.cards.length > 0) {
		console.error(`Severe fallback: card "${name}" (UID ${uid}) not found anywhere. Returning first card in container: ${container.cards[0].name}`);
		return container.cards[0];
	}
	
	console.error(`Severe error: card "${name}" (UID ${uid}) not found anywhere and container is empty.`);
	return null;
}

class OnlineManager {
	constructor() {
		this.peer = null;
		this.conn = null;
		this.isHost = false;
		this.roomId = null;
		
		this.playerName = localStorage.getItem('mpPlayerName') || 'Geralt';
		this.opponentName = 'Opponent';
		
		this.myFaction = null;
		this.myLeaderIndex = null;
		this.myShuffledCards = null;
		
		this.opponentFaction = null;
		this.opponentLeaderIndex = null;
		this.opponentShuffledCards = null;
		
		this.isMultiplayer = false;
		this.myReady = false;
		this.opponentReady = false;
		
		this.myRedrawDone = false;
		this.opponentRedrawDone = false;
		
		this.pendingResolvers = {};
		this.bufferedChoices = {};

		// Serializes every game-state mutation (local plays AND incoming remote moves)
		// so that turn transitions never run concurrently. Without this, a remote
		// move could be applied while the local turn-end animation is still running,
		// leaving the two clients disagreeing about whose turn it is (turn hangs /
		// "both players have the turn").
		this._actionLock = Promise.resolve();

		this.init();
	}

	init() {
		this.setupDOM();
		this.checkUrlParams();
	}

	setupDOM() {
		// Set name input default value
		const nameInput = document.getElementById('mp-player-name');
		if (nameInput) {
			nameInput.value = this.playerName;
			nameInput.addEventListener('input', (e) => {
				this.playerName = e.target.value.trim() || 'Geralt';
				localStorage.setItem('mpPlayerName', this.playerName);
			});
		}

		// Mode Selection Buttons
		document.getElementById('btn-play-ai').addEventListener('click', () => {
			document.getElementById('mp-lobby-overlay').classList.add('hide');
			this.isMultiplayer = false;
		});

		document.getElementById('btn-play-online').addEventListener('click', () => {
			this.showStep('mp-step-online');
		});

		document.getElementById('btn-back-to-mode').addEventListener('click', () => {
			this.showStep('mp-step-mode');
		});

		// Connection Setup Buttons
		document.getElementById('btn-host-match').addEventListener('click', () => {
			this.hostMatch();
		});

		document.getElementById('btn-join-match').addEventListener('click', () => {
			const roomId = document.getElementById('mp-join-room-id').value.trim();
			if (!roomId) return alert('Please enter a room ID.');
			this.joinMatch(roomId);
		});

		// Copy Link Button
		document.getElementById('btn-copy-link').addEventListener('click', () => {
			const inviteLink = document.getElementById('mp-invite-link');
			inviteLink.select();
			document.execCommand('copy');
			
			const copyBtn = document.getElementById('btn-copy-link');
			copyBtn.textContent = 'Copied!';
			setTimeout(() => copyBtn.textContent = 'Copy', 2000);
		});

		// Disconnect Button
		document.getElementById('btn-disconnect').addEventListener('click', () => {
			this.disconnect();
		});
	}

	checkUrlParams() {
		const urlParams = new URLSearchParams(window.location.search);
		const room = urlParams.get('room');
		if (room) {
			this.showStep('mp-step-mode');
			document.getElementById('btn-play-ai').classList.add('hide');
			document.getElementById('btn-play-online').classList.add('hide');
			
			const inviteBtn = document.getElementById('btn-join-invite');
			inviteBtn.classList.remove('hide');
			inviteBtn.addEventListener('click', () => {
				document.getElementById('mp-join-room-id').value = room;
				this.joinMatch(room);
			});
		}
	}

	showStep(stepId) {
		document.querySelectorAll('.mp-step').forEach(step => step.classList.remove('active'));
		document.getElementById(stepId).classList.add('active');
	}

	updateLobbyUI() {
		document.getElementById('mp-player-name-me').textContent = this.playerName + ' (You)';
		
		const opNameSpan = document.getElementById('mp-player-name-op');
		const opDot = document.getElementById('mp-player-dot-op');
		
		if (this.conn && this.conn.open) {
			opNameSpan.textContent = this.opponentName;
			opNameSpan.classList.remove('waiting');
			opDot.classList.add('online');
		} else {
			opNameSpan.textContent = 'Waiting for player 2...';
			opNameSpan.classList.add('waiting');
			opDot.classList.remove('online');
		}
	}

	disconnect() {
		if (this.conn) this.conn.close();
		if (this.peer) this.peer.destroy();
		
		this.peer = null;
		this.conn = null;
		this.isMultiplayer = false;
		
		this.resetLobbyState();
		
		document.getElementById('mp-room-info').classList.add('hide');
		document.getElementById('mp-lobby-status-text').textContent = 'Creating room...';

		// Remove online indicator
		const indicator = document.getElementById('mp-online-indicator');
		if (indicator) indicator.remove();

		this.showStep('mp-step-online');
	}

	hostMatch() {
		this.isHost = true;
		this.showStep('mp-step-lobby');
		document.getElementById('mp-lobby-status-text').textContent = 'Generating Room ID...';

		this.peer = new Peer();

		this.peer.on('open', (id) => {
			this.roomId = id;
			document.getElementById('mp-lobby-status-text').textContent = 'Waiting for your friend...';
			
			// Show invite link
			const cleanUrl = window.location.origin + window.location.pathname;
			document.getElementById('mp-invite-link').value = `${cleanUrl}?room=${id}`;
			document.getElementById('mp-room-info').classList.remove('hide');
			
			this.updateLobbyUI();
		});

		this.peer.on('connection', (connection) => {
			if (this.conn) {
				// Reject duplicate connections
				connection.close();
				return;
			}
			this.conn = connection;
			this.setupConnection();
		});

		this.peer.on('error', (err) => {
			console.error('Peer error:', err);
			alert('Peer error: ' + err.type);
			this.disconnect();
		});
	}

	joinMatch(roomId) {
		this.isHost = false;
		this.showStep('mp-step-lobby');
		document.getElementById('mp-lobby-status-text').textContent = 'Connecting to Host...';

		this.peer = new Peer();

		this.peer.on('open', () => {
			this.conn = this.peer.connect(roomId);
			this.setupConnection();
		});

		this.peer.on('error', (err) => {
			console.error('Peer error:', err);
			alert('Could not connect to room. Make sure the ID is correct and the Host is waiting.');
			this.disconnect();
		});
	}

	setupConnection() {
		this.conn.on('open', () => {
			this.isMultiplayer = true;
			this.updateLobbyUI();
			
			// Exchange names
			this.conn.send({
				type: 'HANDSHAKE',
				name: this.playerName
			});
		});

		this.conn.on('data', (data) => {
			this.handleMessage(data);
		});

		this.conn.on('close', () => {
			alert('Opponent disconnected.');
			this.disconnect();
			// Reload page to reset Gwent state cleanly
			window.location.href = window.location.origin + window.location.pathname;
		});
	}

	handleMessage(data) {
		console.log('Received Message:', JSON.stringify(data));
		switch (data.type) {
			case 'HANDSHAKE':
				this.opponentName = data.name;
				this.updateLobbyUI();
				
				if (this.isHost) {
					// Host replies with handshake too
					this.conn.send({
						type: 'HANDSHAKE',
						name: this.playerName
					});
				}
				
				// Wait 1.5 seconds then enter customization
				setTimeout(() => {
					document.getElementById('mp-lobby-overlay').classList.add('hide');
					this.createOnlineIndicator();
				}, 1500);
				break;
				
			case 'READY':
				this.opponentFaction = data.faction;
				this.opponentLeaderIndex = data.leaderIndex;
				this.opponentShuffledCards = data.shuffledCards;
				this.opponentReady = true;
				
				if (this.isHost && this.myReady) {
					this.hostStartMatch();
				} else {
					this.checkLobbyReady();
				}
				break;
				
			case 'START':
				this.opponentFaction = data.opponentFaction;
				this.opponentLeaderIndex = data.opponentLeaderIndex;
				this.opponentShuffledCards = data.opponentShuffledCards;
				this.opponentReady = true;
				
				this.startGameMultiplayer(data.firstPlayer);
				break;
				
			case 'PLAY_CARD':
				this.executeRemoteMove(async () => {
					let card = getCardByUidWithNameFallback(data.cardUid, data.cardName, player_op.hand, player_op);
					if (!card) {
						console.error('PLAY_CARD: card not found', data.cardName);
						await player_op.endTurn();
						return;
					}
					let row = data.rowIndex === -1 ? weather : board.row[5 - data.rowIndex];
					let source = player_op.hand;
					if (player_op.deck.cards.includes(card)) source = player_op.deck;
					else if (player_op.grave.cards.includes(card)) source = player_op.grave;
					await player_op.playCardAction(card, async () => await board.moveTo(card, row, source));
				});
				break;
				
			case 'SCORCH':
				this.executeRemoteMove(async () => {
					let card = getCardByUidWithNameFallback(data.cardUid, data.cardName, player_op.hand, player_op);
					if (!card) {
						console.error('SCORCH: card not found', data.cardName);
						await player_op.endTurn();
						return;
					}
					await player_op.playCardAction(card, async () => await ability_dict["scorch"].activated(card));
				});
				break;
				
			case 'DECOY':
				this.executeRemoteMove(async () => {
					let decoy = getCardByUidWithNameFallback(data.decoyUid, data.decoyName, player_op.hand, player_op);
					if (!decoy) {
						console.error('DECOY: decoy card not found', data.decoyName);
						await player_op.endTurn();
						return;
					}
					let row = board.row[5 - data.targetRowIndex];
					let target = getCardByUidWithNameFallback(data.targetCardUid, data.targetCardName, row, player_op.opponent());
					if (target) {
						await board.toHand(target, row);
						await board.moveTo(decoy, row, player_op.hand);
					} else {
						console.error('DECOY: target card not found', data.targetCardName);
					}
					await player_op.endTurn();
				});
				break;
				
			case 'PASS':
				this.executeRemoteMove(async () => {
					await player_op.passRound();
				});
				break;
				
			case 'LEADER':
				this.executeRemoteMove(async () => {
					await player_op.activateLeader();
				});
				break;
				
			case 'CHOICE':
				this.resolveChoice(data.choiceType, data.data);
				break;
				
			case 'REDRAW':
				this.executeRemoteMove(async () => {
					nextInsertIndex = data.deckInsertIndex;
					let card = getCardByUidWithNameFallback(data.cardUid, data.cardName, player_op.hand, player_op);
					if (!card) {
						console.error('REDRAW: card not found', data.cardName);
						return;
					}
					player_op.deck.swap(player_op.hand, card);
				});
				break;
				
			case 'REDRAW_DONE':
				this.opponentRedrawDone = true;
				break;
				
			case 'VERIFY_DECKS':
				console.log("Received remote deck verification:", data);
				// remote's opCards is their representation of my deck.
				// remote's myCards is their representation of their deck.
				let myActualCards = player_me.deck.cards.map(c => `${c.uid}:${c.name}`);
				let opActualCards = player_op.deck.cards.map(c => `${c.uid}:${c.name}`);
				
				let errs = [];
				data.opCards.forEach((cDesc, i) => {
					if (myActualCards[i] !== cDesc) {
						errs.push(`My deck card ${i} mismatch: Local is ${myActualCards[i] || 'none'}, Remote expects ${cDesc}`);
					}
				});
				data.myCards.forEach((cDesc, i) => {
					if (opActualCards[i] !== cDesc) {
						errs.push(`Opponent deck card ${i} mismatch: Local is ${opActualCards[i] || 'none'}, Remote expects ${cDesc}`);
					}
				});
				
				if (errs.length > 0) {
					console.error("DECK MISMATCH DETECTED:", errs);
					console.log("Attempting to align local UIDs with remote expectation...");
					
					data.opCards.forEach((cDesc, i) => {
						if (!cDesc) return;
						let parts = cDesc.split(':');
						let uid = parseInt(parts[0]);
						let name = parts.slice(1).join(':');
						let localCard = player_me.deck.cards[i];
						if (localCard) {
							if (localCard.name !== name) {
								console.warn(`Align warning: card ${i} name differs: local is ${localCard.name}, remote expects ${name}`);
							}
							localCard.uid = uid;
						}
					});
					data.myCards.forEach((cDesc, i) => {
						if (!cDesc) return;
						let parts = cDesc.split(':');
						let uid = parseInt(parts[0]);
						let name = parts.slice(1).join(':');
						let localCard = player_op.deck.cards[i];
						if (localCard) {
							if (localCard.name !== name) {
								console.warn(`Align warning: card ${i} name differs: local is ${localCard.name}, remote expects ${name}`);
							}
							localCard.uid = uid;
						}
					});
					
					console.log("UIDs force-aligned to prevent mismatch.");
				} else {
					console.log("DECK VERIFICATION SUCCESSFUL! DECKS ARE IN SYNC.");
				}
				break;
		}
	}

	createOnlineIndicator() {
		// Remove existing one
		const old = document.getElementById('mp-online-indicator');
		if (old) old.remove();

		const indicator = document.createElement('div');
		indicator.id = 'mp-online-indicator';
		indicator.className = 'mp-online-indicator';
		indicator.innerHTML = `
			<span class="mp-player-dot online"></span>
			<span>Playing Online vs <strong>${this.opponentName}</strong></span>
		`;
		document.getElementById('deck-customization').appendChild(indicator);
		
		// Hide opponent custom deck picker in customization screen
		const opPreview = document.getElementById('opponent-preview');
		if (opPreview) opPreview.style.display = 'none';
	}

	sendAction(action) {
		if (this.conn && this.conn.open) {
			this.conn.send(action);
		}
	}

	sendChoice(choiceType, data) {
		this.sendAction({
			type: 'CHOICE',
			choiceType: choiceType,
			data: data
		});
	}

	waitForChoice(type) {
		return new Promise((resolve) => {
			if (this.bufferedChoices[type] && this.bufferedChoices[type].length > 0) {
				resolve(this.bufferedChoices[type].shift());
				return;
			}
			if (!this.pendingResolvers[type]) {
				this.pendingResolvers[type] = [];
			}
			this.pendingResolvers[type].push(resolve);
		});
	}

	resolveChoice(type, data) {
		if (this.pendingResolvers[type] && this.pendingResolvers[type].length > 0) {
			let resolve = this.pendingResolvers[type].shift();
			resolve(data);
		} else {
			if (!this.bufferedChoices[type]) {
				this.bufferedChoices[type] = [];
			}
			this.bufferedChoices[type].push(data);
		}
	}

	// Host shuffles both decks, tosses coin, and launches the match
	hostStartMatch() {
		const hostFirst = Math.random() < 0.5;
		
		// Send START info to Guest
		this.conn.send({
			type: 'START',
			opponentFaction: this.myFaction,
			opponentLeaderIndex: this.myLeaderIndex,
			opponentShuffledCards: this.myShuffledCards,
			firstPlayer: hostFirst ? 'host' : 'guest'
		});
		
		this.startGameMultiplayer(hostFirst ? 'host' : 'guest');
	}

	checkLobbyReady() {
		const startBtn = document.getElementById('start-game');
		if (this.myReady && !this.opponentReady) {
			if (startBtn) {
				startBtn.textContent = 'Waiting for opponent...';
				startBtn.disabled = true;
			}
		}
	}

	// Runs `fn` with exclusive access to the game state. Calls are queued and run
	// strictly one after another (FIFO), each fully completing — including its turn
	// transition — before the next begins. Choice/handshake messages bypass this
	// (they must be free to resolve while a queued move is waiting on them).
	runExclusive(fn) {
		const run = this._actionLock.then(() => fn());
		// Keep the chain alive even if a move throws, so the queue never stalls.
		this._actionLock = run.then(() => {}, () => {});
		return run;
	}

	async executeRemoteMove(actionFn) {
		return this.runExclusive(async () => {
			isSimulatingRemoteMove = true;
			try {
				await actionFn();
			} catch (e) {
				console.error('Error executing remote move:', e);
			} finally {
				isSimulatingRemoteMove = false;
			}
		});
	}

	resetLobbyState() {
		this.myReady = false;
		this.opponentReady = false;
		this.myRedrawDone = false;
		this.opponentRedrawDone = false;
		this.myShuffledCards = null;
		this.opponentShuffledCards = null;
		this.myFaction = null;
		this.opponentFaction = null;
		this.myLeaderIndex = null;
		this.opponentLeaderIndex = null;
		nextInsertIndex = null;

		const startBtn = document.getElementById('start-game');
		if (startBtn) {
			startBtn.textContent = 'Start game';
			startBtn.disabled = false;
		}
	}

	startGameMultiplayer(firstPlayerVal) {
		this.pendingResolvers = {};
		this.bufferedChoices = {};
		this.myReady = false;
		this.opponentReady = false;
		this.myRedrawDone = false;
		this.opponentRedrawDone = false;
		// Reset the Card UID counter so UIDs are deterministic
		Card._nextUid = 0;

		// me_deck cards are pre-shuffled lists
		const me_deck = {
			faction: this.myFaction,
			leader: card_dict[this.myLeaderIndex],
			cards: this.myShuffledCards.map(idx => ({ index: idx, count: 1 }))
		};

		const op_deck = {
			faction: this.opponentFaction,
			leader: card_dict[this.opponentLeaderIndex],
			cards: this.opponentShuffledCards.map(idx => ({ index: idx, count: 1 }))
		};

		// Create players - cards get auto-assigned UIDs via the counter.
		// Player 0 (me) is always created first, then Player 1 (op).
		// Both sides create players in the same me-then-op order, but "me" is
		// a different physical player on each side. So auto-assigned UIDs differ.
		// 
		// Fix: after creation, we re-assign UIDs based on the *shuffled deck position*
		// which is the same data on both sides (exchanged during READY/START).
		isInitializingDecks = true;
		player_me = new Player(0, this.playerName, me_deck);
		player_op = new Player(1, this.opponentName, op_deck);
		isInitializingDecks = false;

		// Re-assign deterministic UIDs.
		// "my" deck cards get UIDs 1000 .. 1000+N-1 (based on myShuffledCards order)
		// "op" deck cards get UIDs 2000 .. 2000+M-1 (based on opponentShuffledCards order)
		// Leader UIDs: me=0, op=500
		// This way, a card at position i in myShuffledCards always gets uid 1000+i
		// regardless of which physical player is "me" vs "op" on each side.
		//
		// On Host:  myShuffledCards = host's deck → uids 1000+i
		//           opponentShuffledCards = guest's deck → uids 2000+i
		// On Guest: myShuffledCards = guest's deck → uids 1000+i (WRONG - guest's deck is 2000+i on host)
		//
		// So we need a different scheme: assign UIDs based on FACTION/SOURCE, not me/op.
		// Better: use the shuffled card *dict indices* themselves as the basis.
		// Since card_dict indices are globally unique per card type, but duplicates exist...
		//
		// Simplest correct approach: On Host, me=host, op=guest.
		//   Host's cards get UIDs starting from 1000, Guest's from 2000.
		// On Guest, me=guest, op=host.
		//   Guest needs HOST's cards to have UIDs from 1000, GUEST's from 2000.
		// But Guest's "me" IS the guest, whose cards should be 2000+i...
		//
		// The fix: assign UIDs based on isHost flag.
		// Host side: player_me cards → "host" UIDs, player_op cards → "guest" UIDs
		// Guest side: player_me cards → "guest" UIDs, player_op cards → "host" UIDs
		
		const hostBase = 1000;
		const guestBase = 2000;
		
		const myBase = this.isHost ? hostBase : guestBase;
		const opBase = this.isHost ? guestBase : hostBase;
		
		// Assign UIDs to leader
		player_me.leader.uid = myBase;
		player_op.leader.uid = opBase;
		
		// Assign UIDs to deck cards based on their position in the shuffled deck
		// Both sides have the same shuffled arrays, so deck position → UID mapping is consistent
		player_me.deck.cards.forEach((card, i) => {
			card.uid = myBase + 1 + i;
		});
		player_op.deck.cards.forEach((card, i) => {
			card.uid = opBase + 1 + i;
		});

		// Diagnostic verification check & force-alignment trigger
		let myCardsDesc = player_me.deck.cards.map(c => `${c.uid}:${c.name}`);
		let opCardsDesc = player_op.deck.cards.map(c => `${c.uid}:${c.name}`);
		this.sendAction({
			type: 'VERIFY_DECKS',
			myCards: myCardsDesc,
			opCards: opCardsDesc
		});

		player_op.controller = new ControllerOnline(player_op);

		// Determine who starts
		let firstPlayerObj = player_me;
		if (this.isHost && firstPlayerVal === 'guest') {
			firstPlayerObj = player_op;
		} else if (!this.isHost && firstPlayerVal === 'host') {
			firstPlayerObj = player_op;
		}
		
		game.firstPlayer = firstPlayerObj;

		// Start game
		dm.elem.classList.add("hide");
		game.startGame();
	}
}

// Instantiate multiplayer manager
window.online = new OnlineManager();

/* ----------- Monkeypatches & Intercepts ----------- */

let isInitializingDecks = false;
let isSimulatingRemoteMove = false;
let nextInsertIndex = null;

// Prevent random insertions during deck initializations or sync insertions
const originalAddCardRandom = CardContainer.prototype.addCardRandom;
CardContainer.prototype.addCardRandom = function(card) {
	if (isInitializingDecks) {
		this.cards.push(card);
		return this.cards.length - 1;
	}
	if (nextInsertIndex !== null) {
		const index = nextInsertIndex;
		nextInsertIndex = null;
		this.cards.push(card);
		if (index !== this.cards.length - 1) {
			let t = this.cards[this.cards.length - 1];
			this.cards[this.cards.length - 1] = this.cards[index];
			this.cards[index] = t;
		}
		return index;
	}
	return originalAddCardRandom.call(this, card);
};

// Sync deck swap / redraw - now uses card UID and name instead of hand index
const originalSwap = Deck.prototype.swap;
Deck.prototype.swap = function(container, card) {
	if (!online.isMultiplayer) {
		return originalSwap.call(this, container, card);
	}
	
	const removedCard = container.removeCard(card);
	const insertedIndex = this.addCardRandom(removedCard);
	this.addCardElement();
	this.resize();
	
	const drawnCard = this.removeCard(0);
	container.addCard(drawnCard);
	
	if (container === player_me.hand) {
		online.sendAction({
			type: 'REDRAW',
			cardUid: card.uid,
			cardName: card.name,
			deckInsertIndex: insertedIndex
		});
	}
};

// Wrap DeckMaker startNewGame to handle ready exchanges
const originalStartNewGame = DeckMaker.prototype.startNewGame;
DeckMaker.prototype.startNewGame = function() {
	if (!online.isMultiplayer) {
		return originalStartNewGame.call(this);
	}
	
	// Validation first
	let warning = "";
	if (this.stats.units < 22)
		warning += "Your deck must have at least 22 unit cards. \n";
	if (this.stats.special > 10)
		warning += "Your deck must have no more than 10 special cards. \n";
	if (warning != "") {
		AudioManager.playSFX("warning");
		return alert(warning);
	}

	// Prepare deck info
	const expanded = Card.expandIDCounts(this.deck.filter(x => x.count > 0));
	const shuffledIndices = expanded.map(c => card_dict.indexOf(c));
	shuffleArray(shuffledIndices); // Shuffle locally

	online.myFaction = this.faction;
	online.myLeaderIndex = this.leader.index;
	online.myShuffledCards = shuffledIndices;
	online.myReady = true;

	online.sendAction({
		type: 'READY',
		faction: this.faction,
		leaderIndex: this.leader.index,
		shuffledCards: shuffledIndices
	});

	if (online.isHost && online.opponentReady) {
		online.hostStartMatch();
	} else {
		online.checkLobbyReady();
	}
};

// Sync player pass.
// NOTE: we key "is this a local action" off player identity (this === player_me),
// NOT off isSimulatingRemoteMove. The remote replay always acts on player_op, while
// the local player only ever passes their own round. Using the flag here is unsafe:
// it stays true through the remote move's endTurn, which already re-enables the local
// player, so an eager click in that window would be misread as a remote move and the
// PASS/PLAY would never be sent (turn "not transmitted" / desync).
const originalPassRound = Player.prototype.passRound;
Player.prototype.passRound = function() {
	if (!online.isMultiplayer || this !== player_me) {
		return originalPassRound.call(this);
	}
	// Local pass: serialize against remote moves and await the full turn transition.
	return online.runExclusive(async () => {
		online.sendAction({ type: 'PASS' });
		await originalPassRound.call(this);
	});
};

// Sync leader activation (same identity-based reasoning as passRound).
const originalActivateLeader = Player.prototype.activateLeader;
Player.prototype.activateLeader = function() {
	if (!online.isMultiplayer || this !== player_me) {
		return originalActivateLeader.call(this);
	}
	return online.runExclusive(async () => {
		online.sendAction({ type: 'LEADER' });
		await originalActivateLeader.call(this);
	});
};

// Replay of remote card plays runs through playCardAction (player_op is a passive
// ControllerOnline). Local human plays are intercepted in UI.selectRow below.
const originalPlayCardAction = Player.prototype.playCardAction;
Player.prototype.playCardAction = async function(card, action) {
	if (!online.isMultiplayer) {
		return await originalPlayCardAction.call(this, card, action);
	}

	// Remote replay: apply the action and finish the turn. Already serialized by
	// executeRemoteMove and already animated on the originating client.
	if (isSimulatingRemoteMove) {
		await action();
		await this.endTurn();
		return;
	}

	// Direct local play (not via selectRow). Capture the target row BEFORE the
	// preview is hidden, since hidePreview() clears ui.lastRow.
	const rowIndex = board.row.indexOf(ui.lastRow);
	ui.showPreviewVisuals(card);
	await sleep(1000);
	ui.hidePreview(card);

	await action();

	if (card.name === "Scorch") {
		online.sendAction({ type: 'SCORCH', cardUid: card.uid, cardName: card.name });
	} else if (card.name !== "Decoy") {
		online.sendAction({ type: 'PLAY_CARD', cardUid: card.uid, cardName: card.name, rowIndex: rowIndex });
	}

	await this.endTurn();
};

// Sync playing of standard unit / special / weather / scorch cards. The local
// human plays through UI.selectRow (NOT Player.playCardAction), so the move sync
// must live here. The action is sent AFTER placement so that any choice packets
// produced by placed abilities (e.g. medic carousels) are delivered first.
const originalSelectRow = UI.prototype.selectRow;
UI.prototype.selectRow = async function(row) {
	// Only intercept genuine local card plays. selectRow is a local UI click handler
	// only (remote plays are replayed through playCardAction), so we gate on "it's my
	// turn" rather than isSimulatingRemoteMove — the flag is still set during the
	// remote move's turn transition that re-enables us, which would wrongly suppress a
	// quick local play. Everything else (viewing a row, decoy targeting, agile-row
	// selection via placedEffectsActive) falls through to the original handler.
	if (!online.isMultiplayer || game.placedEffectsActive
		|| game.currPlayer !== player_me || !this.previewCard
		|| this.previewCard.name === "Decoy") {
		return await originalSelectRow.call(this, row);
	}

	const card = this.previewCard;
	const isScorch = card.name === "Scorch";
	const rowIndex = board.row.indexOf(row); // captured before any hidePreview

	return online.runExclusive(async () => {
		this.lastRow = row;
		this.hidePreview();
		this.enablePlayer(false);

		// Brief "card being played" preview, matching the originating-side pacing.
		ui.showPreviewVisuals(card);
		await sleep(1000);
		ui.hidePreview();

		if (isScorch) {
			await ability_dict["scorch"].activated(card);
			online.sendAction({ type: 'SCORCH', cardUid: card.uid, cardName: card.name });
		} else {
			await board.moveTo(card, row, card.holder.hand);
			online.sendAction({ type: 'PLAY_CARD', cardUid: card.uid, cardName: card.name, rowIndex: rowIndex });
		}

		await card.holder.endTurn();
	});
};

// Sync decoy swap - uses card UID and name for decoy and target identification
const originalSelectCard = UI.prototype.selectCard;
UI.prototype.selectCard = async function(card) {
	// Local decoy play only (remote decoys are replayed via the DECOY handler). Gate on
	// turn ownership, not isSimulatingRemoteMove (see selectRow/passRound note).
	if (!(online.isMultiplayer && this.previewCard && this.previewCard.name === "Decoy"
		&& game.currPlayer === player_me)) {
		return await originalSelectCard.call(this, card);
	}

	const decoy = this.previewCard;
	const targetRow = this.lastRow;
	// Not a valid decoy target (clicked elsewhere) -> let the original handle it.
	if (!targetRow || !targetRow.cards.includes(card)) {
		return await originalSelectCard.call(this, card);
	}
	const targetRowIndex = board.row.indexOf(targetRow);

	return online.runExclusive(async () => {
		online.sendAction({
			type: 'DECOY',
			decoyUid: decoy.uid,
			decoyName: decoy.name,
			targetRowIndex: targetRowIndex,
			targetCardUid: card.uid,
			targetCardName: card.name
		});

		this.hidePreview();
		this.enablePlayer(false);
		await board.toHand(card, targetRow);
		await board.moveTo(decoy, targetRow, decoy.holder.hand);
		await decoy.holder.endTurn();
	});
};

// Sync initial redraw done
const originalInitialRedraw = Game.prototype.initialRedraw;
Game.prototype.initialRedraw = async function() {
	if (!online.isMultiplayer) {
		return await originalInitialRedraw.call(this);
	}
	
	// Local player redraw
	await ui.queueCarousel(player_me.hand, 2, async (c, i) => { 
		AudioManager.playSFX('redraw');
		await player_me.deck.swap(c, c.cards[i]);
	}, c => true, false, true, "Choose up to 2 cards to redraw.");
	ui.enablePlayer(false);
	
	// Send done redraw message
	online.sendAction({ type: 'REDRAW_DONE' });
	online.myRedrawDone = true;
	
	// Wait for remote player redraw done
	await sleepUntil(() => online.opponentRedrawDone === true, 100);

	// Discard any choice packets that may have been buffered during the redraw
	// phase so the first real in-game carousel starts from a clean slate.
	online.pendingResolvers = {};
	online.bufferedChoices = {};
};

// Sync Carousel Selection - now with robust card name matching fallbacks
const originalQueueCarousel = UI.prototype.queueCarousel;
UI.prototype.queueCarousel = async function(container, count, action, predicate, bSort, bQuit, title) {
	// Only sync carousels that happen during actual gameplay (currPlayer is set).
	// During the initial redraw currPlayer is still null and the swap is already
	// synced through the dedicated REDRAW message; sending 'carousel' choices here
	// would pollute the buffer and corrupt the first in-game carousel (e.g. medic).
	if (!online.isMultiplayer || !game.currPlayer) {
		return await originalQueueCarousel.call(this, container, count, action, predicate, bSort, bQuit, title);
	}

	if (game.currPlayer === player_op) {
		// Remote player's turn: wait for choice
		for (let i = 0; i < count; ++i) {
			let choice = await online.waitForChoice('carousel');
			let card = getCardByUidWithNameFallback(choice.cardUid, choice.cardName, container, game.currPlayer);
			let index = container.cards.indexOf(card);
			if (index === -1) {
				console.error('queueCarousel: card not found with name', choice.cardName);
				index = choice.index !== undefined ? choice.index : 0;
			}
			await action(container, index);
		}
		return;
	}
	
	// Local player's turn: wrap callback to capture and send selected card UID and name
	const wrappedAction = async (c, index) => {
		const card = c.cards[index];
		online.sendChoice('carousel', { cardUid: card ? card.uid : 0, cardName: card ? card.name : '', index: index });
		await action(c, index);
	};
	
	return await originalQueueCarousel.call(this, container, count, wrappedAction, predicate, bSort, bQuit, title);
};

// Sync Agile Row Selection
const originalWaitForRowSelection = UI.prototype.waitForRowSelection;
UI.prototype.waitForRowSelection = async function(card) {
	if (!online.isMultiplayer) {
		return await originalWaitForRowSelection.call(this, card);
	}

	if (card.holder === player_op) {
		let choice = await online.waitForChoice('agile_row');
		return board.row[5 - choice.rowIndex]; // Mirror!
	}
	
	let selectedRow = await originalWaitForRowSelection.call(this, card);
	if (selectedRow) {
		online.sendChoice('agile_row', { rowIndex: board.row.indexOf(selectedRow) });
	}
	return selectedRow;
};

// Sync Monsters Faction Ability
factions.monsters.factionAbility = function(player) {
	game.roundEnd.push(async () => {
		const units = board.row.filter( (r,i) => player === player_me ^ i < 3)
			.reduce((a,r) => r.cards.filter(c => c.isUnit()).concat(a), []);
		if (units.length === 0)
			return false;
		
		let card;
		if (player === player_me) {
			card = units[Math.floor(Math.random() * units.length)];
			online.sendChoice('monsters_keep', { cardUid: card.uid, cardName: card.name, index: units.indexOf(card) });
		} else {
			let choice = await online.waitForChoice('monsters_keep');
			let container = new CardContainer();
			container.cards = units;
			card = getCardByUidWithNameFallback(choice.cardUid, choice.cardName, container, player);
		}
		
		card.noRemove = true;
		game.roundStart.push( async () => {
			await ui.notification("monsters", 1200);
			delete card.noRemove;
			return true; 
		});
		return false;
	});
};

// Sync Scoia'tael Faction Ability
factions.scoiatael.factionAbility = player => game.gameStart.push( async () => {
	let notif = "";
	if (player === player_me) {
		let goFirst = null;
		await ui.popup("Go First", () => goFirst = true, "Let Opponent Start", () => goFirst = false, "Would you like to go first?", "The Scoia'tael faction perk allows you to decide who will get to go first.", 0.55);
		if (goFirst) {
			game.firstPlayer = player;
		} else {
			game.firstPlayer = player.opponent();
		}
		online.sendChoice('scoiatael_first', { firstPlayer: goFirst ? 'me' : 'op' });
		notif = game.firstPlayer.tag + "-first";
	} else {
		// Wait for choice from remote player
		let choice = await online.waitForChoice('scoiatael_first');
		if (choice.firstPlayer === 'me') {
			game.firstPlayer = player; // Opponent goes first
		} else {
			game.firstPlayer = player.opponent(); // We go first
		}
		notif = game.firstPlayer.tag + "-first";
	}
	await ui.notification(notif, 1200);
	return true;
});

// Sync Skellige Faction Ability
factions.skellige.helper = async player => {
	let card;
	let units = player.grave.cards.filter(c => c.isUnit());
	if (units.length === 0)
		return;
		
	if (player === player_me) {
		card = units[Math.floor(Math.random() * units.length)];
		online.sendChoice('skellige_draw', { cardUid: card.uid, cardName: card.name, cardIndexInGrave: player.grave.cards.indexOf(card) });
	} else {
		let choice = await online.waitForChoice('skellige_draw');
		card = getCardByUidWithNameFallback(choice.cardUid, choice.cardName, player.grave, player);
	}
	
	if (card.row === 'agile') {
		let selectedRow;
		if (player === player_me) {
			selectedRow = await ui.waitForRowSelection(card);
			if (selectedRow) {
				online.sendChoice('skellige_agile', { rowIndex: board.row.indexOf(selectedRow) });
			}
		} else {
			let choice = await online.waitForChoice('skellige_agile');
			selectedRow = board.row[5 - choice.rowIndex]; // Mirror!
		}
		if (selectedRow) {
			await board.moveTo(card, selectedRow, player.grave);
		}
	} else {
		await board.toRow(card, player.grave);
	}
};

// Hide Rematch and New Game buttons on the end screen in multiplayer mode
const originalEndGame = Game.prototype.endGame;
Game.prototype.endGame = async function() {
	const res = await originalEndGame.call(this);
	if (online.isMultiplayer) {
		const buttons = this.endScreen.getElementsByTagName("button");
		if (buttons[1]) buttons[1].classList.add("hide");
		if (buttons[2]) buttons[2].classList.add("hide");
	}
	return res;
};

const originalReturnToCustomization = Game.prototype.returnToCustomization;
Game.prototype.returnToCustomization = function() {
	if (online.isMultiplayer) {
		online.resetLobbyState();
	}
	const buttons = this.endScreen.getElementsByTagName("button");
	if (buttons[1]) buttons[1].classList.remove("hide");
	if (buttons[2]) buttons[2].classList.remove("hide");
	return originalReturnToCustomization.call(this);
};

