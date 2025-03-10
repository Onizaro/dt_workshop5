import bodyParser from "body-parser";
import express from "express";
import axios from "axios";
import { BASE_NODE_PORT } from "../config";
import { Value } from "../types";

type NodeState = {
  killed: boolean;
  x: 0 | 1 | "?" | null;
  decided: boolean | null;
  k: number | null;
};

type MessageType = "PHASE_1" | "PHASE_2";

interface Message {
  type: MessageType;
  k: number;
  value: Value | null;
  sender: number;
}

export async function node(
  nodeId: number,
  N: number,
  F: number,
  initialValue: Value,
  isFaulty: boolean,
  nodesAreReady: () => boolean,
  setNodeIsReady: (index: number) => void
) {
  const node = express();
  node.use(express.json());
  node.use(bodyParser.json());

  let killed = false;
  let x: 0 | 1 | "?" | null = isFaulty ? null : initialValue as 0 | 1 | "?" | null;
  let decided: boolean | null = isFaulty ? null : false;
  let k: number | null = isFaulty ? null : 0;

  const messages: Record<number, { phase1: Message[], phase2: Message[] }> = {};

  const initMessageStorage = (step: number) => {
    if (!messages[step]) {
      messages[step] = { phase1: [], phase2: [] };
    }
  };

  const broadcast = async (message: Message) => {
    if (killed || isFaulty) return;

    for (let i = 0; i < N; i++) {
      if (i !== nodeId) {
        try {
          await axios.post(`http://localhost:${BASE_NODE_PORT + i}/message`, { message });
        } catch (error) {
          console.log(`Node ${nodeId} failed to send message to Node ${i}`);
        }
      }
    }
  };

  // Cette fonction modifiée gère mieux les nœuds défectueux
  const runStep = async (step: number) => {
    if (killed || decided !== false || isFaulty) return;

    k = step;
    initMessageStorage(step);

    console.log(`Node ${nodeId} broadcasting Phase 1 with value ${x} at step ${step}`);
    await broadcast({ type: "PHASE_1", k: step, value: x, sender: nodeId });

    const requiredMessages = N - F - 1;
    let waitTime = 0;
    const checkInterval = 100;
    const maxWaitTime = 5000;

    while (!killed && messages[step].phase1.length < requiredMessages && waitTime < maxWaitTime) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      waitTime += checkInterval;
    }

    if (killed) return;

    let zeros = 0;
    let ones = 0;

    if (x === 0) zeros++;
    else if (x === 1) ones++;

    for (const msg of messages[step].phase1) {
      if (msg.value === 0) zeros++;
      else if (msg.value === 1) ones++;
    }

    console.log(`Node ${nodeId} at step ${step}, Phase 1 counts: zeros=${zeros}, ones=${ones}`);

    let newValue: Value;
    if (zeros >= Math.floor((N + 1) / 2)) {
      newValue = 0;
    } else if (ones >= Math.floor((N + 1) / 2)) {
      newValue = 1;
    } else {
      newValue = Math.random() < 0.5 ? 0 : 1;
    }

    console.log(`Node ${nodeId} broadcasting Phase 2 with value ${newValue} at step ${step}`);
    await broadcast({ type: "PHASE_2", k: step, value: newValue, sender: nodeId });

    waitTime = 0;
    while (!killed && messages[step].phase2.length < requiredMessages && waitTime < maxWaitTime) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      waitTime += checkInterval;
    }

    if (killed) return;

    zeros = 0;
    ones = 0;

    if (newValue === 0) zeros++;
    else if (newValue === 1) ones++;

    for (const msg of messages[step].phase2) {
      if (msg.value === 0) zeros++;
      else if (msg.value === 1) ones++;
    }

    console.log(`Node ${nodeId} at step ${step}, Phase 2 counts: zeros=${zeros}, ones=${ones}`);

    // Réglage des valeurs pour le consensus en prenant en compte les nœuds défectueux
    if (zeros >= Math.ceil((N - F) / 2)) {
      x = 0;
      if (zeros >= N - F) {
        decided = true;
      }
    } else if (ones >= Math.ceil((N - F) / 2)) {
      x = 1;
      if (ones >= N - F) {
        decided = true;
      }
    } else {
      x = "?";
    }

    console.log(`Node ${nodeId} at step ${step}, new value = ${x}, decided = ${decided}`);

    // Si on dépasse la tolérance aux pannes, aucun nœud défectueux ne doit être marqué comme "decided"
    if (F > ((N-1)/2)) {
      if (isFaulty) {
        decided = null;  // Assurez-vous que les nœuds défectueux ne sont pas marqués comme décidés
        x = null;
        k = null;
      }
    }

    // Ne pas avancer si le consensus n'est pas encore atteint
    if (!killed && decided === false && (F <= N - F)) {
      setTimeout(() => runStep(step + 1), 50);
    }
  };


  node.get("/status", (req, res) => {
    if (isFaulty) {
      return res.status(500).send("faulty");
    }
    return res.status(200).send("live");
  });

  node.post("/message", (req, res) => {
    if (killed) return res.status(200).send("Node is stopped");

    const { message } = req.body;

    if (!isFaulty) {
      const { type, k: step, value, sender } = message;

      console.log(`Node ${nodeId} received ${type} message with value ${value} from ${sender} for step ${step}`);

      initMessageStorage(step);

      if (type === "PHASE_1") {
        if (!messages[step].phase1.some(m => m.sender === sender)) {
          messages[step].phase1.push(message);
        }
      } else if (type === "PHASE_2") {
        if (!messages[step].phase2.some(m => m.sender === sender)) {
          messages[step].phase2.push(message);
        }
      }
    }

    return res.status(200).send("Message received");
  });

  node.get("/start", async (req, res) => {
    if (killed) return res.status(200).send("Node is stopped");

    console.log(`Node ${nodeId} starting consensus algorithm...`);

    if (decided === false && !isFaulty) {
      k = 0;
      setTimeout(() => runStep(0), 50);
    }

    return res.status(200).send("Consensus algorithm started");
  });

  node.get("/stop", async (req, res) => {
    console.log(`Node ${nodeId} stopping consensus algorithm...`);
    killed = true;
    return res.status(200).send("Consensus algorithm stopped");
  });

  node.get("/getState", (req, res) => {
    const currentState: NodeState = {
      killed,
      x,
      decided,
      k,
    };

    console.log(`Node ${nodeId} state:`, currentState);
    return res.status(200).json(currentState);
  });

  const server = node.listen(BASE_NODE_PORT + nodeId, async () => {
    console.log(`Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`);
    setNodeIsReady(nodeId);
  });

  return server;
}
