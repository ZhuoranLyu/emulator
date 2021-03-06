angular.module('myApp')
.service('randomService', function () {
  'use strict';

  if (!Math.seedrandom) {
    throw new Error("You forgot to include in your HTML: <script src='http://cdnjs.cloudflare.com/ajax/libs/seedrandom/2.3.11/seedrandom.min.js'></script>");
  }
  var originalRandom = Math.random;
  var seededRandom = null;
  var randomValues = null;
  var seed = null;

  this.setSeed = function (_seed) {
    seed = _seed;
    randomValues = [];
    Math.seedrandom(seed);
    seededRandom = Math.random;
    Math.random = function () {
      throw new Error("Do NOT use Math.random(); Instead, use randomService.random(randomIndex)");
    };
  };

  function checkRandomIndex(randomIndex) {
    if (randomIndex === undefined) {
      throw new Error("You forgot to pass randomIndex when calling randomService method, e.g., you should call randomService.random(42); randomIndex should be an index of a random number. In a specific match, calling randomService.random(42) multiple times will return the same random number.");
    }
  }

  this.random = function (randomIndex) {
    checkRandomIndex(randomIndex);
    for (var i = randomValues.length; i <= randomIndex; i++) {
      randomValues[i] = seededRandom();
    }
    return randomValues[randomIndex];
  };

  this.randomFromTo = function (randomIndex, from, to) {
    checkRandomIndex(randomIndex);
    if (from === undefined || to === undefined || from >= to) {
      throw new Error("In randomService.randomFromTo(randomIndex, from,to), you must have from<to, but from=" + from + " to=" + to);
    }
    return Math.floor(this.random(randomIndex) * (to - from) + from);
  };

  this.doNotUseInYourGameGetOriginalMathRandom = function () { return originalRandom(); };

  this.setSeed(0);
})
.service('realTimeService',
  ["$window", "$log", "$timeout", "messageService", "resizeGameAreaService", "randomService",
    function($window, $log, $timeout, messageService, resizeGameAreaService, randomService) {

  'use strict';

  /* API summary:
  realTimeService.init({createCanvasController, canvasWidth, canvasHeight})
  createCanvasController(canvas)
  canvasController.gotStartMatch({matchController, playersInfo, yourPlayerIndex})
  canvasController.gotMessage({fromPlayerIndex, message});
  canvasController.gotEndMatch(endMatchScores)
  matchController.sendReliableMessage(‘only strings’)
  matchController.sendUnreliableMessage(‘only strings’)
  matchController.endMatch(endMatchScores)
  */
  var maxPlayers = 8;

  var urlParams = function () {
    var query = location.search.substr(1);
    var result = {};
    query.split("&").forEach(function(part) {
      var item = part.split("=");
      result[item[0]] = decodeURIComponent(item[1]);
    });
    return result;
  } ();

  var messagePasser = function () {
    var isLocalTesting = $window.parent === $window;
    // You can set the number of test local players using the URL search portion:
    // ?testPlayers=2
    var numberOfLocalTestPlayers = Number(urlParams.testPlayers);
    if (!numberOfLocalTestPlayers) {
      numberOfLocalTestPlayers = 1;
    }
    if (numberOfLocalTestPlayers > maxPlayers) {
      throw new Error("The maximum number of players is 8!");
    }

    function sendLocalTestingStartMatch() {
      $timeout(function () {
        $log.info("Sending gotStartMatch");
        var playersInfo = [];
        for (var i = 0; i < numberOfLocalTestPlayers; i++) {
          playersInfo.push({playerId: 42 + i});
        }
        handleMessage({
          gotStartMatch: {
            playersInfo: playersInfo,
            // No yourPlayerIndex because we want isSingleDevice.
            randomSeed: "someRandomSeed" + randomService.doNotUseInYourGameGetOriginalMathRandom()
          }
        });
      }, 2000);
    }

    function init() {
      if (isLocalTesting) {
        sendLocalTestingStartMatch();
      } else {
        messageService.addMessageListener(handleMessage);
        messageService.sendMessage({gameReady: true});
      }
    }

    function sendMessage(msg) {
      if (isLocalTesting) {
        if (msg.endMatch) {
          sendLocalTestingStartMatch();
        } else {
          // sendReliableMessage or sendUnreliableMessage
          throw new Error("Shouldn't send messages in local testing");
        }
      } else {
        messageService.sendMessage(msg);
      }
    }

    return {init: init, sendMessage: sendMessage};
  }();

  var canvasWidth = null;
  var canvasHeight = null;
  var canvases = null;
  var canvasControllers = null;
  var playersInfo = null; // This is not null iff there is an ongoing game.
  // isSingleDevice is true if we use a single device (if gotStartMatch had no yourPlayerIndex),
  // or if this is an online multiplayer game (against other opponents).
  var isSingleDevice = null;

  var simulateDelay = Number(urlParams.delay);
  if (!simulateDelay) {
    simulateDelay = 0;
  }
  var simulateLosingUnreliableMsgs = Number(urlParams.loseUnreliable);
  if (!simulateLosingUnreliableMsgs) {
    simulateLosingUnreliableMsgs = 0;
  }
  var canvasControllersMessageQueue = [];

  function sendMessageNowToCanvasController(index, msg) {
    var canvasController = canvasControllers[index];
    if (msg.gotMessage) {
      canvasController.gotMessage(msg.gotMessage);
    } else if (msg.gotStartMatch) {
      canvasController.gotStartMatch(msg.gotStartMatch);
    } else if (msg.gotEndMatch !== undefined) { // can be null
      canvasController.gotEndMatch(msg.gotEndMatch);
    } else {
      throw new Error("Unknown msg=" + angular.toJson(msg));
    }
  }

  function sendMessageToCanvasController(index, msg) {
    if (simulateDelay === 0) {
      sendMessageNowToCanvasController(index, msg);
      return;
    }
    canvasControllersMessageQueue[index].push(msg);
    $timeout(function () {
      var _msg = canvasControllersMessageQueue[index].shift();
      sendMessageNowToCanvasController(index, _msg);
    }, simulateDelay * randomService.doNotUseInYourGameGetOriginalMathRandom());
  }

  function init(params) {
    if (canvasControllers) {
      throw new Error("You can call realTimeService.init(params) exactly once!");
    }
    var createCanvasController = params.createCanvasController;
    if (!params || !params.createCanvasController ||
        !params.canvasWidth || !params.canvasHeight) {
      throw new Error("When calling realTimeService.init(params), " +
          "params must contain: createCanvasController, canvasWidth, canvasHeight.");
    }
    $window.gameDeveloperEmail = params.gameDeveloperEmail;
    canvasWidth = params.canvasWidth;
    canvasHeight = params.canvasHeight;
    var bodyStr = '<div id="gameArea">';
    var i;
    for (i = 0; i < maxPlayers; i++) {
      bodyStr += '<canvas id="canvas' + i +
          '" style="display: none; margin: 0; padding: 0; position: absolute;" width="' +
          canvasWidth + '" height="' + canvasHeight + '"></canvas>';
    }
    canvases = [];
    canvasControllers = [];
    document.body.innerHTML += bodyStr + '</div>';
    for (i = 0; i < maxPlayers; i++) {
      var canvas = document.getElementById("canvas" + i);
      if (!canvas) {
        throw new Error("Couldn't find canvas" + i);
      }
      canvases[i] = canvas;
      var canvasController = createCanvasController(canvas);
      if (!canvasController || !canvasController.gotStartMatch ||
          !canvasController.gotMessage || !canvasController.gotEndMatch) {
        throw new Error("createCanvasController should return a canvasController " +
            "with the methods: gotStartMatch, gotMessage, and gotEndMatch.");
      }
      canvasControllers[i] = safeCanvasController(canvasController);
      canvasControllersMessageQueue[i] = [];
    }
    messagePasser.init();
  }

  function safeCanvasController(canvasController) {
    var isOngoing = false;
    function gotStartMatch(p) {
      if (isOngoing) {
        canvasController.gotEndMatch(null);
      }
      isOngoing = true;
      canvasController.gotStartMatch(p);
    }
    function gotMessage(p) {
      if (isOngoing) {
        canvasController.gotMessage(p);
      }
    }
    function gotEndMatch(p) {
      if (isOngoing) {
        canvasController.gotEndMatch(p);
      }
      isOngoing = false;
    }
    return {gotStartMatch: gotStartMatch, gotMessage: gotMessage, gotEndMatch: gotEndMatch};
  }

  function createSingleDeviceMatchController(playerIndex) {
    function singleDeviceSendMessage(msg, isReliable) {
      if (!playersInfo) {
        // Game is already over.
        return;
      }
      checkSendMessage(msg);
      var gotMessage = {fromPlayerIndex: playerIndex, message: msg};
      for (var i = 0; i < playersInfo.length; i++) {
        if (i !== playerIndex) {
          // Simulate losing unreliable msgs
          if (simulateLosingUnreliableMsgs !== 0 &&
              !isReliable &&
              randomService.doNotUseInYourGameGetOriginalMathRandom() < simulateLosingUnreliableMsgs) {
            continue;
          }
          sendMessageToCanvasController(i, {gotMessage: gotMessage});
        }
      }
    }

    function singleDeviceEndMatch(endMatchScores) {
      if (!playersInfo) {
        // Game is already over.
        return;
      }
      $log.info("Got endMatchScores=" + endMatchScores);
      for (var i = 0; i < playersInfo.length; i++) {
        sendMessageToCanvasController(i, {gotEndMatch: endMatchScores});
      }
      endMatch(endMatchScores);
    }

    return {
      sendReliableMessage: function (msg) {
        singleDeviceSendMessage(msg, true);
      },
      sendUnreliableMessage: function (msg) {
        singleDeviceSendMessage(msg, false);
      },
      endMatch: singleDeviceEndMatch
    };
  }

  function getBestRowsCols(numberOfPlayers) {
    var windowWidth = window.innerWidth;
    var windowHeight = window.innerHeight;
    var maxScale = null;
    var bestRowsCols = null;
    for (var rows = 1; rows <= numberOfPlayers; rows++) {
      for (var cols = 1; cols <= numberOfPlayers; cols++) {
        if (rows * cols !== numberOfPlayers) {
          continue;
        }
        var totalWidth = canvasWidth * cols;
        var totalHeight = canvasHeight * rows;
        var scaleW = windowWidth / totalWidth;
        var scaleH = windowHeight / totalHeight;
        var scale = Math.min(scaleW, scaleH);
        if (!maxScale || scale > maxScale) {
          maxScale = scale;
          bestRowsCols = {rows: rows, cols: cols};
        }
      }
    }
    return bestRowsCols;
  }

  function changeCanvasesDispay(numberOfPlayers) {
    // Hide all canvases
    for (var i = 0; i < maxPlayers; i++) {
      canvases[i].style.display = i < numberOfPlayers ? "inline" : "none";
    }
    // Decide how many rows and cols in the grid
    var bestRowsCols = getBestRowsCols(numberOfPlayers);
    var rows = bestRowsCols.rows;
    var cols = bestRowsCols.cols;
    resizeGameAreaService.setWidthToHeight(canvasWidth * cols / (canvasHeight * rows));
    var canvasPercentWidth = 100 / cols;
    var canvasPercentHeight = 100 / rows;
    var margin = 0.05; // 5% margins
    for (var row = 0; row < rows; row++) {
      for (var col = 0; col < cols; col++) {
        var top = row * canvasPercentHeight + (canvasPercentHeight * margin) / 2;
        var left = col * canvasPercentWidth + (canvasPercentWidth * margin) / 2;
        var p = col + row * cols;
        canvases[p].style.top = "" + top + "%";
        canvases[p].style.left = "" + left + "%";
        canvases[p].style.width = "" + (canvasPercentWidth * (1 - margin)) + "%";
        canvases[p].style.height = "" + (canvasPercentHeight * (1 - margin)) + "%";
      }
    }
  }

  function handleGotStartMatch(gotStartMatch) {
    handleGotEndMatch(null); // stop all existing matches.
    playersInfo = gotStartMatch.playersInfo;
    if (!playersInfo || !playersInfo.length) {
      throw new Error("Got gotStartMatch where playersInfo wasn't a non-empty array");
    }
    if (playersInfo.length > maxPlayers) {
      throw new Error("Got gotStartMatch where playersInfo has more than 8 players!");
    }
    if (!gotStartMatch.randomSeed) {
      throw new Error("Got gotStartMatch without randomSeed!");
    }
    isSingleDevice = gotStartMatch.yourPlayerIndex === undefined;
    changeCanvasesDispay(isSingleDevice ? playersInfo.length : 1);
    randomService.setSeed(gotStartMatch.randomSeed);
    if (!isSingleDevice) {
      sendMessageToCanvasController(0, {gotStartMatch: {
        playersInfo: playersInfo,
        yourPlayerIndex: gotStartMatch.yourPlayerIndex,
        matchController: {
          sendReliableMessage: sendReliableMessage,
          sendUnreliableMessage: sendUnreliableMessage,
          endMatch: endMatch
        }
      }});
    } else {
      for (var i = 0; i < playersInfo.length; i++) {
        sendMessageToCanvasController(i, {gotStartMatch: {
          playersInfo: playersInfo,
          yourPlayerIndex: i,
          matchController: createSingleDeviceMatchController(i)
        }});
      }
    }
  }

  function handleGotMessage(gotMessage) {
    if (isSingleDevice) {
      throw new Error("Got gotMessage when isSingleDevice");
    }
    if (!playersInfo) {
      return;
    }
    if (playersInfo.length <= 1) {
      throw new Error("Got message.gotMessage in single-player.");
    }
    canvasControllers[0].gotMessage(gotMessage);
  }

  function handleGotEndMatch(gotEndMatch) {
    // The user can cancel a single-device game
    playersInfo = null;
    // Because of safeCanvasController, we can just send gotEndMatch to all controllers.
    for (var i = 0; i < canvasControllers.length; i++) {
      canvasControllers[i].gotEndMatch(gotEndMatch);
    }
  }

  function handleMessage(message) {
    $window.lastMessage = message;
    if (message.gotStartMatch) {
      handleGotStartMatch(message.gotStartMatch);
    } else if (message.gotMessage) {
      handleGotMessage(message.gotMessage);
    } else if (message.gotEndMatch !== undefined) { // can be null
      handleGotEndMatch(message.gotEndMatch);
    } else {
      throw new Error("Unknown message: " + angular.toJson(message));
    }
  }

  function checkSendMessage(msg) {
    if (!msg || typeof msg !== "string") {
      throw new Error("When calling realTimeService.sendReliableMessage(message), " +
          "you must pass a non-empty string as the message.");
    }
    if (msg.length >= 1000) {
      console.error("CAREFUL: Maximum message length is 1000, but you passed a message of length " +
          msg.length +
          ". The platform will try to zip the message, but if it is still big then we might send it in chunks or the match will be ended in a tie");
    }
    if (!playersInfo) {
      throw new Error("You must not send a message before getting game.startMatch");
    }
  }

  function checkMultiDeviceMessage(msg) {
    checkSendMessage(msg);
    if (isSingleDevice) {
      throw new Error("Trying to send message when isSingleDevice");
    }
    return playersInfo.length === 1;
  }

  function sendReliableMessage(msg) {
    if (checkMultiDeviceMessage(msg)) {
      return;
    }
    messagePasser.sendMessage({sendReliableMessage: msg});
  }

  function sendUnreliableMessage(msg) {
    if (checkMultiDeviceMessage(msg)) {
      return;
    }
    messagePasser.sendMessage({sendUnreliableMessage: msg});
  }

  function endMatch(endMatchScores) {
    if (!playersInfo) {
      throw new Error("You must not call realTimeService.endMatch(endMatchScores) before getting game.gotStartMatch");
    }
    if (!endMatchScores || endMatchScores.length !== playersInfo.length) {
      throw new Error("When calling realTimeService.endMatch(endMatchScores), " +
          "you must pass an array of the same length as the number of players in gotStartMatch.");
    }
    playersInfo = null;
    messagePasser.sendMessage({endMatch: endMatchScores});
  }

  this.init = init;
}]);
