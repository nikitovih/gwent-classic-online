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

// Helper: find a card by uid across all opponent containers
function findOpCardByUid(uid) {
	// Search hand first (most common)
	let card = findCardByUid(player_op.hand, uid);
	if (card) return { card, source: player_op.hand };
	// Search deck
	card = findCardByUid(player_op.deck, uid);
	if (card) return { card, source: player_op.deck };
	// Search grave
	card = findCardByUid(player_op.grave, uid);
	if (card) return { card, source: player_op.grave };
	// Search board rows
	for (let row of board.row) {
		card = findCardByUid(row, uid);
		if (card) return { card, source: row };
	}
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
			this.showStep('mp-step-online');
			document.getElementById('mp-join-room-id').value = room;
			// We delay auto-joining slightly to make sure DOM is fully ready
			setTimeout(() => this.joinMatch(room), 500);
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
		this.myReady = false;
		this.opponentReady = false;
		this.myRedrawDone = false;
		this.opponentRedrawDone = false;
		
		document.getElementById('mp-room-info').classList.add('hide');
		document.getElementById('mp-lobby-status-text').textContent = 'Creating room...';
		
		// Reset the customization Screen Button
		const startBtn = document.getElementById('start-game');
		if (startBtn) {
			startBtn.textContent = 'Start game';
			startBtn.disabled = false;
		}

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
		console.log('Received Message:', data);
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
					let card = findCardByUid(player_op.hand, data.cardUid);
					if (!card) {
						console.error('PLAY_CARD: card not found with uid', data.cardUid);
						return;
					}
					let row = board.row[5 - data.rowIndex];
					await board.moveTo(card, row, player_op.hand);
					player_op.endTurn();
				});
				break;
				
			case 'SCORCH':
				this.executeRemoteMove(async () => {
					let card = findCardByUid(player_op.hand, data.cardUid);
					if (!card) {
						console.error('SCORCH: card not found with uid', data.cardUid);
						return;
					}
					await ability_dict["scorch"].activated(card);
					player_op.endTurn();
				});
				break;
				
			case 'DECOY':
				this.executeRemoteMove(async () => {
					let decoy = findCardByUid(player_op.hand, data.decoyUid);
					if (!decoy) {
						console.error('DECOY: decoy card not found with uid', data.decoyUid);
						return;
					}
					let row = board.row[5 - data.targetRowIndex];
					let target = row.cards[data.targetCardIndexInRow];
					board.toHand(target, row);
					await board.moveTo(decoy, row, player_op.hand);
					player_op.endTurn();
				});
				break;
				
			case 'PASS':
				this.executeRemoteMove(async () => {
					player_op.passRound();
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
					let card = findCardByUid(player_op.hand, data.cardUid);
					if (!card) {
						console.error('REDRAW: card not found with uid', data.cardUid);
						return;
					}
					player_op.deck.swap(player_op.hand, card);
				});
				break;
				
			case 'REDRAW_DONE':
				this.opponentRedrawDone = true;
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

	async executeRemoteMove(actionFn) {
		isSimulatingRemoteMove = true;
		await actionFn();
		isSimulatingRemoteMove = false;
	}

	startGameMultiplayer(firstPlayerVal) {
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

// Sync deck swap / redraw - now uses card UID instead of hand index
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

// Sync player pass
const originalPassRound = Player.prototype.passRound;
Player.prototype.passRound = function() {
	if (online.isMultiplayer && !isSimulatingRemoteMove) {
		online.sendAction({ type: 'PASS' });
	}
	return originalPassRound.call(this);
};

// Sync leader activation
const originalActivateLeader = Player.prototype.activateLeader;
Player.prototype.activateLeader = function() {
	if (online.isMultiplayer && !isSimulatingRemoteMove) {
		online.sendAction({ type: 'LEADER' });
	}
	return originalActivateLeader.call(this);
};

// Sync playing standard unit cards or weather cards - now uses card UID
const originalSelectRow = UI.prototype.selectRow;
UI.prototype.selectRow = async function(row) {
	if (online.isMultiplayer && this.previewCard && !isSimulatingRemoteMove) {
		let card = this.previewCard;
		let rowIndex = board.row.indexOf(row);
		
		if (card.name === "Scorch") {
			online.sendAction({
				type: 'SCORCH',
				cardUid: card.uid
			});
		} else if (card.name !== "Decoy") {
			online.sendAction({
				type: 'PLAY_CARD',
				cardUid: card.uid,
				rowIndex: rowIndex
			});
		}
	}
	return await originalSelectRow.call(this, row);
};

// Sync decoy swap - now uses card UID for decoy identification
const originalSelectCard = UI.prototype.selectCard;
UI.prototype.selectCard = async function(card) {
	if (online.isMultiplayer && this.previewCard && this.previewCard.name === "Decoy" && !isSimulatingRemoteMove) {
		let decoyUid = this.previewCard.uid;
		let targetRow = this.lastRow;
		let targetRowIndex = board.row.indexOf(targetRow);
		let targetCardIndexInRow = targetRow.cards.indexOf(card);
		
		online.sendAction({
			type: 'DECOY',
			decoyUid: decoyUid,
			targetRowIndex: targetRowIndex,
			targetCardIndexInRow: targetCardIndexInRow
		});
	}
	return await originalSelectCard.call(this, card);
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
};

// Sync Carousel Selection
const originalQueueCarousel = UI.prototype.queueCarousel;
UI.prototype.queueCarousel = async function(container, count, action, predicate, bSort, bQuit, title) {
	if (!online.isMultiplayer) {
		return await originalQueueCarousel.call(this, container, count, action, predicate, bSort, bQuit, title);
	}

	if (game.currPlayer === player_op) {
		// Remote player's turn: wait for choice
		for (let i = 0; i < count; ++i) {
			let choice = await online.waitForChoice('carousel');
			await action(container, choice.index);
		}
		return;
	}
	
	// Local player's turn: wrap callback to capture and send selected index
	const wrappedAction = async (c, index) => {
		online.sendChoice('carousel', { index: index });
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
			online.sendChoice('monsters_keep', { index: units.indexOf(card) });
		} else {
			let choice = await online.waitForChoice('monsters_keep');
			card = units[choice.index];
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
		online.sendChoice('skellige_draw', { cardIndexInGrave: player.grave.cards.indexOf(card) });
	} else {
		let choice = await online.waitForChoice('skellige_draw');
		card = player.grave.cards[choice.cardIndexInGrave];
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
