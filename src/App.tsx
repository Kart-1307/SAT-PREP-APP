import { useState, useEffect, useRef, useMemo } from "react";
import {
  Sparkles,
  Settings,
  Database as DbIcon,
  AlertTriangle,
  Activity,
  BookOpen,
  RotateCcw,
  CheckCircle,
  AlertCircle,
  ArrowRight,
  Sliders,
  RefreshCw,
  Edit3,
  Filter,
  Check,
  X,
  FileText,
  Download,
  UserCheck,
  StopCircle
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import {
  Question,
  TestProfileConfig,
  PipelineRun,
  ValidationAuditLog,
  AnswerChoice,
  Section,
  Domain,
  BatchRun
} from "./types";
import { auth } from "./lib/firebase";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  User,
  GoogleAuthProvider,
  signInWithPopup
} from "firebase/auth";
import { LogOut, User as UserIcon, Lock, Mail, Eye, EyeOff } from "lucide-react";

export default function App() {
  // Auth State
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [isSignUp, setIsSignUp] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [guestMode, setGuestMode] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);

  // State variables
  const [selectedExam, setSelectedExam] = useState<"SAT" | "GRE">("SAT");
  const [activeTab, setActiveTab] = useState<"generate" | "bank" | "review" | "analytics" | "docs">("generate");
  const [config, setConfig] = useState<TestProfileConfig | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [questionsLoaded, setQuestionsLoaded] = useState(false);
  const [auditLogs, setAuditLogs] = useState<ValidationAuditLog[]>([]);
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<PipelineRun | null>(null);

  // Pipeline parameters
  const [selectedSection, setSelectedSection] = useState<string>("");
  const [selectedDomain, setSelectedDomain] = useState<string>("");
  const [selectedSkill, setSelectedSkill] = useState<string>("");
  const [selectedDifficulty, setSelectedDifficulty] = useState<string>("Medium");

  // Batch generation ("all combinations") state
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [activeBatchRun, setActiveBatchRun] = useState<BatchRun | null>(null);
  const [isStoppingBatch, setIsStoppingBatch] = useState(false);
  const [isStoppingSingle, setIsStoppingSingle] = useState(false);

  // Single question vs combinations vs upload
  const [specMode, setSpecMode] = useState<"single" | "combinations" | "upload">("single");
  const [uploadedQuestions, setUploadedQuestions] = useState<any[]>([]);
  const [isDraggingFile, setIsDraggingFile] = useState(false);

  // "all" = every combination in the config; "custom" = a multi-selected subset.
  // Domain/skill options are derived from what's selected, and pruned below
  // whenever an upstream selection changes.
  const [batchScope, setBatchScope] = useState<"all" | "custom">("all");
  const [batchSections, setBatchSections] = useState<string[]>([]);
  const [batchDomains, setBatchDomains] = useState<string[]>([]);
  const [batchSkills, setBatchSkills] = useState<string[]>([]);
  const [batchDifficulties, setBatchDifficulties] = useState<string[]>([]);
  const batchPollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const trackedBatchComboRef = useRef<string | null>(null);

  // UI States
  const [isGenerating, setIsGenerating] = useState(false);
  // Tracks which rejected question_ids currently have a "send back to
  // generator" regeneration request in flight, so we can disable that
  // specific button / show a spinner without blocking the rest of the UI.
  const [regeneratingIds, setRegeneratingIds] = useState<Set<string>>(new Set());
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [domainFilter, setDomainFilter] = useState<string>("all");
  // Bank tab was rendering every matching question's full card (passage,
  // choices, QA audit grid, explanation) all at once — with a few thousand
  // approved questions that's a huge DOM tree and is what locks up the tab
  // on open. Render one page at a time instead; nothing about the
  // underlying data or fetch logic changes, this is display-only.
  const BANK_PAGE_SIZE = 25;
  const [bankPage, setBankPage] = useState(0);

  // Human Review states
  const [reviewQuestion, setReviewQuestion] = useState<Question | null>(null);
  const [reviewFeedback, setReviewFeedback] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [editPassage, setEditPassage] = useState("");
  const [editStimulus, setEditStimulus] = useState("");
  const [editQuestionText, setEditQuestionText] = useState("");
  const [editChoices, setEditChoices] = useState<AnswerChoice[]>([]);
  const [editCorrectAnswer, setEditCorrectAnswer] = useState("");
  const [editExplanation, setEditExplanation] = useState("");

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const existingRunIdsRef = useRef<Set<string>>(new Set());
  const isTrackingRef = useRef<boolean>(false);
  const isGeneratingRef = useRef<boolean>(false);

  const formatRubricCheckValue = (checkVal: string | number | undefined) => {
    if (checkVal === undefined || checkVal === null) return "";
    const text = checkVal.toString().trim();
    const ratingMatch = text.match(/(\d+)\s*\/\s*5/);
    if (ratingMatch) return text;
    const passFailMatch = text.match(/^(PASS|FAIL)/i);
    const numericMatch = text.match(/(\d+)/);
    if (passFailMatch && numericMatch) {
      return `${passFailMatch[1].toUpperCase()} (${numericMatch[1]}/5)`;
    }
    if (passFailMatch) {
      return `${passFailMatch[1].toUpperCase()} (${passFailMatch[1].toUpperCase() === "PASS" ? "5" : "0"}/5)`;
    }
    if (numericMatch) {
      return `${text}`;
    }
    return text;
  };

  // Auth subscriber
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
      if (currentUser) {
        setGuestMode(false);
      }
    });
    return () => unsubscribe();
  }, []);

  // Fetch initial data
  useEffect(() => {
    setQuestionsLoaded(false);
    fetchConfig();
    fetchQuestions();
    fetchAuditLogs();
    fetchPipelineRuns();
  }, [selectedExam, user, guestMode]);

  // Resume tracking a batch generation job if one is already running for this
  // exam (e.g. the page was refreshed mid-batch).
  useEffect(() => {
    stopBatchPolling();
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/batch-runs?exam_type=${selectedExam}&status=running`);
        if (cancelled) return;
        const runs: BatchRun[] = res.ok ? await res.json() : [];

        if (runs.length > 0) {
          // A batch is actively running for this exam — keep it on screen,
          // don't wipe anything out from under it.
          setActiveBatchRun(runs[0]);
          setIsBatchGenerating(true);
          setIsStoppingBatch(false);
          pollBatchRun(runs[0].batch_id);
        } else {
          // Nothing running for this exam — the previous tracker (if any) is
          // stale, safe to clear now.
          setActiveBatchRun(null);
          setIsBatchGenerating(false);
          setIsStoppingBatch(false);
          setSelectedRun(null);
          trackedBatchComboRef.current = null;
        }
      } catch (e) {
        console.error("Error checking for in-progress batch runs:", e);
      }
    })();

    return () => {
      cancelled = true;
      stopBatchPolling();
    };
  }, [selectedExam]);

  // The "single question" / "all combinations" toggle switches which generation
  // path is active. Only clear the tracker once it's actually finished —
  // a run still in progress should stay visible through the toggle.
  useEffect(() => {
    if (!isGenerating && !isBatchGenerating) {
      setSelectedRun(null);
      trackedBatchComboRef.current = null;
    }
  }, [specMode]);

  // Set default parameters when config loads
  useEffect(() => {
    if (config && config.sections.length > 0) {
      const defaultSec = config.sections[0];
      setSelectedSection(defaultSec.name);
      if (defaultSec.domains.length > 0) {
        setSelectedDomain(defaultSec.domains[0].name);
        if (defaultSec.domains[0].skills.length > 0) {
          setSelectedSkill(defaultSec.domains[0].skills[0]);
        }
      }
    }
  }, [config]);

  // Handle section parameter change
  const handleSectionChange = (secName: string) => {
    setSelectedSection(secName);
    if (config) {
      const sec = config.sections.find((s: Section) => s.name === secName);
      if (sec && sec.domains.length > 0) {
        setSelectedDomain(sec.domains[0].name);
        if (sec.domains[0].skills.length > 0) {
          setSelectedSkill(sec.domains[0].skills[0]);
        }
      }
    }
  };

  // Handle domain parameter change
  const handleDomainChange = (domName: string) => {
    setSelectedDomain(domName);
    if (config) {
      const sec = config.sections.find((s: Section) => s.name === selectedSection);
      if (sec) {
        const dom = sec.domains.find((d: Domain) => d.name === domName);
        if (dom && dom.skills.length > 0) {
          setSelectedSkill(dom.skills[0]);
        }
      }
    }
  };

  // Generic toggle for a value in/out of a multi-select array
  // Switching tabs away from (or back to) Generate makes a *finished*
  // "last question" tracker stale, so clear it — but not while a run is
  // still actually in progress; that should stay visible.
  const handleTabChange = (tab: "generate" | "bank" | "review" | "analytics" | "docs") => {
    setActiveTab(tab);
    if (!isGenerating && !isBatchGenerating) {
      setSelectedRun(null);
      trackedBatchComboRef.current = null;
    }
  };

  const toggleInArray = (list: string[], value: string, setter: (v: string[]) => void) => {
    setter(list.includes(value) ? list.filter(v => v !== value) : [...list, value]);
  };

  // Domains available = union across every currently-selected section.
  // Memoized: this was being recomputed from scratch on every render,
  // including the 800ms/1500ms poll-driven ones, for no reason.
  const availableDomains = useMemo((): Domain[] => {
    if (!config || batchSections.length === 0) return [];
    const seen = new Map<string, Domain>();
    for (const sec of config.sections) {
      if (!batchSections.includes(sec.name)) continue;
      for (const dom of sec.domains) {
        if (!seen.has(dom.name)) seen.set(dom.name, dom);
      }
    }
    return Array.from(seen.values());
  }, [config, batchSections]);
  const batchAvailableDomains = () => availableDomains;

  // Skills available = union across every currently-selected domain
  const availableSkills = useMemo((): string[] => {
    const seen = new Set<string>();
    for (const dom of availableDomains) {
      if (!batchDomains.includes(dom.name)) continue;
      for (const sk of dom.skills) seen.add(sk);
    }
    return Array.from(seen);
  }, [availableDomains, batchDomains]);
  const batchAvailableSkills = () => availableSkills;

  // Prune selections that fall out of the available list as upstream selections change
  useEffect(() => {
    const availableDomainNames = new Set(availableDomains.map(d => d.name));
    setBatchDomains(prev => prev.filter(d => availableDomainNames.has(d)));
  }, [availableDomains]);

  useEffect(() => {
    const availableSkillNames = new Set(availableSkills);
    setBatchSkills(prev => prev.filter(s => availableSkillNames.has(s)));
  }, [availableSkills]);

  // Live count of how many pipeline runs a custom batch would actually trigger —
  // shown next to the selectors so the user isn't guessing until the confirm dialog.
  // Mirrors the nested section→domain→skill logic in buildAllCombinations
  // (a flat multiply would overcount, since not every domain belongs to
  // every section and not every skill belongs to every domain).
  const customComboCount = useMemo(() => {
    if (!config || batchDifficulties.length === 0) return 0;
    let count = 0;
    for (const sec of config.sections) {
      if (!batchSections.includes(sec.name)) continue;
      for (const dom of sec.domains) {
        if (!batchDomains.includes(dom.name)) continue;
        for (const sk of dom.skills) {
          if (batchSkills.includes(sk)) count += batchDifficulties.length;
        }
      }
    }
    return count;
  }, [config, batchSections, batchDomains, batchSkills, batchDifficulties]);

  const fetchConfig = async () => {
    try {
      const res = await fetch(`/api/configs/${selectedExam}`);
      const data = await res.json();
      if (res.ok) {
        setConfig(data);
      } else {
        setErrorMsg(data.error || "Failed to load exam configurations.");
      }
    } catch (e) {
      setErrorMsg("Error connecting to server. Please ensure the backend is running.");
    }
  };

  const fetchQuestions = async () => {
    try {
      const uId = user ? user.uid : "public";
      const res = await fetch(`/api/questions?exam_type=${selectedExam}&userId=${uId}`);
      const data = await res.json();
      if (res.ok) {
        setQuestions(data);
        setQuestionsLoaded(true);
      }
    } catch (e) {
      console.error("Error fetching questions:", e);
    }
  };

  const fetchAuditLogs = async () => {
    try {
      const uId = user ? user.uid : "public";
      const res = await fetch(`/api/audit-logs?userId=${uId}&exam_type=${selectedExam}`);
      const data = await res.json();
      if (res.ok) {
        setAuditLogs(data);
      }
    } catch (e) {
      console.error("Error fetching audit logs:", e);
    }
  };

  const fetchPipelineRuns = async () => {
    try {
      const uId = user ? user.uid : "public";
      const res = await fetch(`/api/pipeline-runs?userId=${uId}&exam_type=${selectedExam}`);
      const data = await res.json();
      if (res.ok) {
        // Defensive re-filter in case selectedExam changed mid-flight
        const filtered = data.filter((run: any) => run.exam_type?.toUpperCase() === selectedExam?.toUpperCase());
        setPipelineRuns(filtered);

        // Track the current active run by locked ID or new ID detection
        if (activeRunIdRef.current) {
          const matched = filtered.find((r: any) => r.question_id === activeRunIdRef.current);
          if (matched) {
            setSelectedRun(matched);
          }
        } else if (isTrackingRef.current && filtered.length > 0) {
          // Find the new run that was not in the database before trigger
          const currentRun = filtered.find((r: any) => !existingRunIdsRef.current.has(r.question_id));
          if (currentRun) {
            activeRunIdRef.current = currentRun.question_id;
            setSelectedRun(currentRun);
          }
        }
      }
    } catch (e) {
      console.error("Error fetching runs:", e);
    }
  };

  // Start polling active pipeline run logs
  const startPollingRuns = () => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = setInterval(() => {
      fetchPipelineRuns();
      fetchQuestions();
      fetchAuditLogs();
    }, 800);
  };

  const stopPollingRuns = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  const handleGenerate = async () => {
    // React state updates aren't synchronous, so `disabled={isGenerating}` alone
    // has a race window on very fast repeated clicks — a plain ref check closes it.
    if (isGeneratingRef.current || isBatchGenerating) return;
    isGeneratingRef.current = true;

    setIsGenerating(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    setSelectedRun(null);
    activeRunIdRef.current = null;
    isTrackingRef.current = true;
    existingRunIdsRef.current = new Set(pipelineRuns.map((r: any) => r.question_id));

    // Immediately start polling to catch logs
    startPollingRuns();

    try {
      const uId = user ? user.uid : "public";
      const res = await fetch("/api/questions/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exam_type: selectedExam,
          section: selectedSection,
          domain: selectedDomain,
          skill_tag: selectedSkill,
          difficulty: selectedDifficulty,
          userId: uId
        })
      });

      const data = await res.json();
      if (res.ok) {
        setSuccessMsg(`Question successfully generated! Final status: ${data.question.status.toUpperCase()}`);
        fetchQuestions();
        fetchAuditLogs();
        fetchPipelineRuns();
      } else if (typeof data.error === "string" && data.error.startsWith("CANCELLED:")) {
        setSuccessMsg("Generation stopped.");
        fetchPipelineRuns();
      } else {
        setErrorMsg(data.error || "Generation pipeline encountered an error.");
      }
    } catch (e) {
      setErrorMsg("Network error trying to contact the generation pipeline.");
    } finally {
      setIsGenerating(false);
      setIsStoppingSingle(false);
      isGeneratingRef.current = false;
      isTrackingRef.current = false;
      // Let it poll once more after completion to grab the final logs, then stop
      setTimeout(() => {
        stopPollingRuns();
        fetchPipelineRuns();
      }, 1500);
    }
  };

  // Requests that the in-progress single-question generation stop. The
  // current attempt finishes, but no new attempt starts — and, same as
  // batch, an incomplete question is never saved.
  const handleStopGenerate = async () => {
    const runId = activeRunIdRef.current || selectedRun?.question_id;
    if (!runId) return;
    if (!confirm("Stop generation? The attempt already in progress will finish, but no further retries will be made.")) return;

    setIsStoppingSingle(true);
    try {
      const res = await fetch(`/api/pipeline-runs/${runId}/stop`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || "Failed to stop generation.");
        setIsStoppingSingle(false);
      }
      // Success case: leave isStoppingSingle true — handleGenerate's finally
      // block clears it once the run actually finishes.
    } catch (e) {
      setErrorMsg("Network error trying to stop generation.");
      setIsStoppingSingle(false);
    }
  };

  // Stop polling an in-flight batch run
  const stopBatchPolling = () => {
    if (batchPollIntervalRef.current) {
      clearInterval(batchPollIntervalRef.current);
      batchPollIntervalRef.current = null;
    }
  };

  // Poll a single batch run by id until it finishes
  const pollBatchRun = (batchId: string) => {
    stopBatchPolling();
    batchPollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/batch-runs/${batchId}`);
        if (!res.ok) return;
        const data: BatchRun = await res.json();
        setActiveBatchRun(data);

        // Keep the question bank / audit views in sync as items complete
        fetchQuestions();
        fetchAuditLogs();

        // Pin the tracker to the item currently running (matched by combo,
        // since question_id isn't assigned until the item finishes).
        try {
          const uId = user ? user.uid : "public";
          const runsRes = await fetch(`/api/pipeline-runs?userId=${uId}&exam_type=${selectedExam}`);
          const runsData = await runsRes.json();
          if (runsRes.ok) {
            const filtered = runsData.filter((run: any) => run.exam_type?.toUpperCase() === selectedExam?.toUpperCase());
            setPipelineRuns(filtered);

            const currentItem = data.items.find((i) => i.status === "running");
            const comboKey = currentItem
              ? `${currentItem.section}|${currentItem.domain}|${currentItem.skill_tag}|${currentItem.difficulty}`
              : null;

            if (comboKey !== trackedBatchComboRef.current) {
              // Batch moved to a new item — clear immediately instead of
              // leaving the previous item's finished logs on screen.
              // Skip this when the batch has already finished: comboKey
              // also goes null on that final tick, and nulling here caused
              // a one-frame flash before the completion block below
              // re-populated selectedRun with the last run.
              trackedBatchComboRef.current = comboKey;
              if (data.status === "running") {
                setSelectedRun(null);
              }
            }

            if (currentItem) {
              const matchingRun = filtered.find((run: any) =>
                run.section === currentItem.section &&
                run.domain === currentItem.domain &&
                run.skill_tag === currentItem.skill_tag &&
                run.difficulty === currentItem.difficulty
              );
              if (matchingRun) {
                setSelectedRun(matchingRun);
              }
            }
            // No currentItem = between items or batch just finished. Stay
            // cleared rather than falling back to the previous item's run —
            // that fallback was what caused the old item to flash back on
            // screen during the gap before the next item starts.
          }
        } catch (e) {
          console.error("Error updating live tracker during batch:", e);
        }

        if (data.status !== "running") {
          stopBatchPolling();
          setIsBatchGenerating(false);
          setIsStoppingBatch(false);

          // Reset custom scope selections now that the batch is done, but
          // leave the tracker alone — the last completed item's run should
          // stay on screen instead of being wiped the moment the batch ends.
          setBatchSections([]);
          setBatchDomains([]);
          setBatchSkills([]);
          setBatchDifficulties([]);
          trackedBatchComboRef.current = null;

          try {
            const uId = user ? user.uid : "public";
            const runsRes = await fetch(`/api/pipeline-runs?userId=${uId}&exam_type=${selectedExam}`);
            const runsData = await runsRes.json();
            if (runsRes.ok) {
              const finishedItems = data.items.filter((i) => i.status === "completed" || i.status === "failed");
              const lastItem = finishedItems[finishedItems.length - 1];
              if (lastItem) {
                const lastRun = runsData.find((run: any) =>
                  run.section === lastItem.section &&
                  run.domain === lastItem.domain &&
                  run.skill_tag === lastItem.skill_tag &&
                  run.difficulty === lastItem.difficulty
                );
                if (lastRun) setSelectedRun(lastRun);
              }
            }
          } catch (e) {
            console.error("Error loading final tracker state after batch completion:", e);
          }

          if (data.status === "completed") {
            setSuccessMsg(`Batch generation complete: ${data.approved}/${data.total} questions approved.`);
          } else if (data.status === "completed_with_escalations") {
            setSuccessMsg(`Batch generation finished: ${data.approved}/${data.total} approved, ${data.escalated} escalated to human review.`);
          } else if (data.status === "completed_with_errors") {
            setSuccessMsg(`Batch generation finished with some errors: ${data.approved}/${data.total} approved, ${data.escalated} escalated, ${data.failed} failed.`);
          } else if (data.status === "stopped") {
            setSuccessMsg(`Batch generation stopped: ${data.approved}/${data.total} questions approved before stopping.`);
          } else {
            setErrorMsg("Batch generation failed to produce any questions.");
          }
        }
      } catch (e) {
        console.error("Error polling batch run:", e);
      }
    }, 1500);
  };

  const processUploadedFile = (file: File) => {
    setErrorMsg(null);
    setSuccessMsg(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const parsed = JSON.parse(text);
        const questionsArray = Array.isArray(parsed) ? parsed : [parsed];

        if (questionsArray.length === 0) {
          throw new Error("JSON file must contain at least one question.");
        }

        // Quick schema verification check for crucial fields
        for (let i = 0; i < questionsArray.length; i++) {
          const q = questionsArray[i];
          if (!q.category) {
            throw new Error(`Item ${i + 1} is missing the required 'category' field.`);
          }
          if (q.difficulty === undefined) {
            throw new Error(`Item ${i + 1} (category: ${q.category}) is missing the 'difficulty' field.`);
          }
        }

        setUploadedQuestions(questionsArray);
        setSuccessMsg(`Successfully loaded ${questionsArray.length} rejected question(s) for regeneration.`);
      } catch (err: any) {
        setErrorMsg(err.message || "Failed to parse JSON file.");
      }
    };
    reader.onerror = () => {
      setErrorMsg("Error reading file.");
    };
    reader.readAsText(file);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    processUploadedFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(true);
  };

  const handleDragLeave = () => {
    setIsDraggingFile(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processUploadedFile(file);
    }
  };

  const handleUploadBatchGenerate = async () => {
    if (uploadedQuestions.length === 0) return;
    if (isGeneratingRef.current || isBatchGenerating) return;

    if (!confirm(`This will generate replacement questions for all ${uploadedQuestions.length} uploaded rejected questions in the background. Continue?`)) return;

    isGeneratingRef.current = true;
    setIsBatchGenerating(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    setActiveBatchRun(null);
    setSelectedRun(null);
    activeRunIdRef.current = null;
    isTrackingRef.current = false;
    trackedBatchComboRef.current = null;

    try {
      const uId = user ? user.uid : "public";
      const res = await fetch("/api/questions/generate-batch-from-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exam_type: selectedExam,
          userId: uId,
          questions: uploadedQuestions
        })
      });

      const data = await res.json();
      if (res.ok) {
        pollBatchRun(data.batch_id);
      } else {
        setErrorMsg(data.error || "Failed to start regeneration batch from upload.");
        setIsBatchGenerating(false);
      }
    } catch (e) {
      setErrorMsg("Network error trying to start upload batch generation.");
      setIsBatchGenerating(false);
    } finally {
      isGeneratingRef.current = false;
    }
  };

  // Runs the Generator/Validator/RAG pipeline for every combination selected.
  const handleBatchGenerate = async () => {
    if (!config) return;
    if (isGeneratingRef.current || isBatchGenerating) return;

    // Custom scope requires at least one selection per category — no implicit "all" fallback
    if (batchScope === "custom") {
      const missing: string[] = [];
      if (batchSections.length === 0) missing.push("section");
      if (batchDomains.length === 0) missing.push("domain");
      if (batchSkills.length === 0) missing.push("skill");
      if (batchDifficulties.length === 0) missing.push("difficulty");
      if (missing.length > 0) {
        setErrorMsg(`Select at least one ${missing.join(", ")} before generating a custom batch.`);
        return;
      }
    }

    const confirmMsg = batchScope === "custom"
      ? `This will generate one question for every selected domain/skill/difficulty combination (${batchSections.length} section(s), ${batchDomains.length} domain(s), ${batchSkills.length} skill(s), ${batchDifficulties.length} difficulty level(s)). This can take a while and may run many pipeline loops. Continue?`
      : `This will generate one question for every domain/skill/difficulty combination in the ${config.name} config. This can take a while and may run many pipeline loops. Continue?`;
    if (!confirm(confirmMsg)) return;

    isGeneratingRef.current = true;
    setIsBatchGenerating(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    setActiveBatchRun(null);
    // Clear leftover tracker state so it starts fresh with the batch's first item.
    setSelectedRun(null);
    activeRunIdRef.current = null;
    isTrackingRef.current = false;
    trackedBatchComboRef.current = null;

    try {
      const uId = user ? user.uid : "public";
      const res = await fetch("/api/questions/generate-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exam_type: selectedExam,
          userId: uId,
          ...(batchScope === "custom" ? {
            sections: batchSections,
            domains: batchDomains,
            skills: batchSkills,
            difficulties: batchDifficulties
          } : {})
        })
      });

      const data = await res.json();
      if (res.ok) {
        pollBatchRun(data.batch_id);
      } else {
        setErrorMsg(data.error || "Failed to start batch generation.");
        setIsBatchGenerating(false);
        // If one was already running, jump straight to tracking it
        if (data.batch_id) {
          pollBatchRun(data.batch_id);
          setIsBatchGenerating(true);
        }
      }
    } catch (e) {
      setErrorMsg("Network error trying to start batch generation.");
      setIsBatchGenerating(false);
    } finally {
      isGeneratingRef.current = false;
    }
  };

  // Requests that the active batch run stop. Workers finish whatever item
  // they're already on and skip the rest — no partial/incomplete question
  // is ever added, since the pipeline itself refuses to save one.
  const handleStopBatch = async (isRetry = false) => {
    if (!activeBatchRun) return;
    if (!isRetry && !confirm("Stop batch generation? Any item already in progress will finish, and the rest will be skipped.")) return;

    setIsStoppingBatch(true);
    try {
      const res = await fetch(`/api/batch-runs/${activeBatchRun.batch_id}/stop`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || "Failed to stop batch generation.");
        setIsStoppingBatch(false);
      }
      // Success case: leave isStoppingBatch true — pollBatchRun clears it
      // once the batch actually finishes stopping.
    } catch (e) {
      // A single dropped request (e.g. a brief server hiccup) shouldn't force
      // the user to notice the error and click Stop again — retry once
      // automatically before surfacing anything.
      if (!isRetry) {
        setTimeout(() => handleStopBatch(true), 1000);
        return;
      }
      setErrorMsg("Network error trying to stop batch generation. Please try again.");
      setIsStoppingBatch(false);
    }
  };

  // Reset database to seeds
  const handleResetDB = async () => {
    if (!confirm("Are you sure you want to reset the database? This will restore the 20 default pre-seeded high-quality SAT questions and wipe any custom generations.")) return;
    try {
      const uId = user ? user.uid : "public";
      const res = await fetch("/api/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: uId })
      });
      if (res.ok) {
        setSuccessMsg("Database successfully reset to default 20 pre-seeded questions.");
        fetchQuestions();
        fetchAuditLogs();
        fetchPipelineRuns();
        setReviewQuestion(null);
        setIsEditing(false);
      }
    } catch (e) {
      setErrorMsg("Failed to reset database.");
    }
  };
  const handleExport = async () => {
    try {
      const res = await fetch("/api/questions/export");
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "approved_questions.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErrorMsg("Failed to export questions.");
    }
  };
  // Export every question in the bank, regardless of status
  // (approved / rejected / escalated), including the status field itself.
  const handleExportAll = async () => {
    try {
      const res = await fetch("/api/questions/export-all");
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "all_questions.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErrorMsg("Failed to export all questions.");
    }
  };
  // Submit human review action (Approve, Reject, or Edit)
  const handleReviewAction = async (action: "approve" | "reject" | "edit") => {
    if (!reviewQuestion) return;

    try {
      const uId = user ? user.uid : "public";
      let body: any = {
        question_id: reviewQuestion.question_id,
        action,
        feedback: reviewFeedback,
        userId: uId
      };

      if (action === "edit") {
        const updated_question = {
          ...reviewQuestion,
          passage: editPassage || null,
          stimulus: editStimulus || null,
          question_text: editQuestionText,
          answer_choices: editChoices,
          correct_answer: editCorrectAnswer,
          explanation: {
            correct_rationale: editExplanation,
            distractor_rationale: reviewQuestion.explanation.distractor_rationale // retain original layout
          }
        };
        body.updated_question = updated_question;
      }

      const res = await fetch("/api/questions/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      const data = await res.json();
      if (res.ok) {
        setSuccessMsg(`Question reviewed successfully. New Status: ${data.status.toUpperCase()}`);
        fetchQuestions();
        setReviewQuestion(null);
        setIsEditing(false);
        setReviewFeedback("");
      } else {
        setErrorMsg(data.error || "Failed to submit review.");
      }
    } catch (e) {
      setErrorMsg("Error submitting human review response.");
    }
  };

  // Send a rejected question back to the Generator Agent for a fresh attempt.
  // Fires the same pipeline used elsewhere (RAG + validation), seeded with
  // this question's rejection feedback, and refreshes the bank/logs/runs
  // once the new question lands so it's visible right away.
  const handleRegenerate = async (q: Question) => {
    if (regeneratingIds.has(q.question_id)) return;
    setRegeneratingIds(prev => new Set(prev).add(q.question_id));
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const uId = user ? user.uid : "public";
      const res = await fetch(`/api/questions/${q.question_id}/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: uId })
      });
      const data = await res.json();
      if (res.ok) {
        setSuccessMsg(`Sent back to the generator. New question ${data.question.question_id} came back ${data.question.status.toUpperCase()}.`);
        fetchQuestions();
        fetchAuditLogs();
        fetchPipelineRuns();
      } else {
        setErrorMsg(data.error || "Failed to send question back to the generator.");
      }
    } catch (e) {
      setErrorMsg("Network error trying to regenerate this question.");
    } finally {
      setRegeneratingIds(prev => {
        const next = new Set(prev);
        next.delete(q.question_id);
        return next;
      });
    }
  };


  // Reject a question AND immediately send it back to the generator, in one
  // click — records the human's rejection (with any comments as feedback),
  // then reuses that same feedback to seed a fresh generation attempt.
  const handleRejectAndRegenerate = async () => {
    if (!reviewQuestion) return;
    const q = reviewQuestion;

    try {
      const uId = user ? user.uid : "public";
      const res = await fetch("/api/questions/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question_id: q.question_id,
          action: "reject",
          feedback: reviewFeedback,
          userId: uId
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || "Failed to submit review.");
        return;
      }
      setReviewQuestion(null);
      setIsEditing(false);
      setReviewFeedback("");
      fetchQuestions();

      await handleRegenerate(q);
    } catch (e) {
      setErrorMsg("Error rejecting and regenerating this question.");
    }
  };

  // Initiate Edit action in Human Review panel
  const startEditing = (q: Question) => {
    setReviewQuestion(q);
    setEditPassage(q.passage || "");
    setEditStimulus(q.stimulus || "");
    setEditQuestionText(q.question_text);
    setEditChoices([...q.answer_choices]);
    setEditCorrectAnswer(q.correct_answer);
    setEditExplanation(q.explanation.correct_rationale);
    setIsEditing(true);
  };

  const updateChoiceText = (idx: number, text: string) => {
    const updated = [...editChoices];
    updated[idx].text = text;
    setEditChoices(updated);
  };

  // Filter bank questions. Memoized — this was re-filtering the entire
  // question list from scratch on every 800ms poll tick even when nothing
  // about the list, search, or filters had changed.
  const filteredQuestions = useMemo(() => questions.filter((q: Question) => {
    const query = searchQuery.toLowerCase();
    const matchesSearch =
      q.question_text.toLowerCase().includes(query) ||
      (q.passage && q.passage.toLowerCase().includes(query)) ||
      q.skill_tag.toLowerCase().includes(query) ||
      q.question_id.toLowerCase().includes(query);

    const matchesStatus = statusFilter === "all" || q.status === statusFilter;
    const matchesDomain = domainFilter === "all" || q.domain === domainFilter;

    return matchesSearch && matchesStatus && matchesDomain;
  }), [questions, searchQuery, statusFilter, domainFilter]);

  const escalatedQuestions = questions.filter((q: Question) => q.status === "escalated");

  // Reset to page 1 whenever the filtered result set changes (new search,
  // new filter, or the underlying data refreshing from a poll) so you're
  // never silently stuck on a now-out-of-range page.
  useEffect(() => {
    setBankPage(0);
  }, [searchQuery, statusFilter, domainFilter]);

  const bankPageCount = Math.max(1, Math.ceil(filteredQuestions.length / BANK_PAGE_SIZE));
  const currentBankPage = Math.min(bankPage, bankPageCount - 1);
  const paginatedBankQuestions = useMemo(
    () => filteredQuestions.slice(currentBankPage * BANK_PAGE_SIZE, (currentBankPage + 1) * BANK_PAGE_SIZE),
    [filteredQuestions, currentBankPage]
  );

  // Calculate QA stats
  const totalLogs = auditLogs.length;
  const passedLogs = auditLogs.filter((l: ValidationAuditLog) => l.validation_status === "PASS").length;
  const passRate = totalLogs > 0 ? Math.round((passedLogs / totalLogs) * 100) : 100;

  const totalSimilarityChecked = auditLogs.length;
  const highSimilarityAlerts = auditLogs.filter((l: ValidationAuditLog) => l.checks.originality?.toString().startsWith("FAIL")).length;

  // Auth Form Helpers
  const [showPassword, setShowPassword] = useState(false);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (!emailInput || !passwordInput) {
      setAuthError("Please fill in both email and password.");
      return;
    }
    try {
      if (isSignUp) {
        await createUserWithEmailAndPassword(auth, emailInput, passwordInput);
        setSuccessMsg("Account successfully created!");
      } else {
        await signInWithEmailAndPassword(auth, emailInput, passwordInput);
        setSuccessMsg("Logged in successfully!");
      }
    } catch (err: any) {
      let friendlyMessage = err.message;
      if (err.code === "auth/invalid-credential") {
        friendlyMessage = "Incorrect email or password. Please try again.";
      } else if (err.code === "auth/email-already-in-use") {
        friendlyMessage = "Email already registered. Try signing in.";
      } else if (err.code === "auth/weak-password") {
        friendlyMessage = "Password should be at least 6 characters.";
      } else if (err.code === "auth/operation-not-allowed") {
        friendlyMessage = "Email/Password authentication is disabled in this Firebase project. To enable: Go to the Firebase Console -> Authentication -> Sign-in method tab -> Click 'Add new provider' -> Select 'Email/Password' -> Toggle 'Enable' and Save.";
      }
      setAuthError(friendlyMessage);
    }
  };

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      setSuccessMsg("Logged in with Google successfully!");
    } catch (err: any) {
      if (err.code !== "auth/popup-closed-by-user") {
        setAuthError(err.message || "Failed to sign in with Google.");
      }
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center font-sans">
        <div className="flex flex-col items-center gap-4 text-center px-4">
          <div className="p-3 bg-emerald-50 rounded-2xl border border-emerald-100">
            <RefreshCw className="w-8 h-8 text-emerald-600 animate-spin" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Initializing Workspace</h3>
            <p className="text-xs text-slate-500 mt-0.5">Setting up cognitive orchestration agents...</p>
          </div>
        </div>
      </div>
    );
  }

  if (!user && !guestMode) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
        {/* Simple Top bar */}
        <header className="border-b border-slate-200/80 bg-white/80 backdrop-blur-md px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-50 text-emerald-600 p-2 rounded-xl border border-emerald-100">
              <Sparkles className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight text-slate-950">
                SATPrep Agent Pipeline
              </h1>
              <p className="text-[10px] text-slate-500">
                Generative Question Validator Engine
              </p>
            </div>
          </div>
          <button
            onClick={() => setGuestMode(true)}
            className="text-xs font-semibold text-slate-600 hover:text-slate-800 bg-white border border-slate-200 hover:bg-slate-50 px-4 py-2 rounded-xl transition shadow-sm"
          >
            Explore as Guest
          </button>
        </header>

        {/* Center Card */}
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="bg-white border border-slate-200 rounded-3xl p-8 max-w-md w-full shadow-sm flex flex-col gap-6">
            <div className="text-center">
              <h2 className="text-xl font-bold text-slate-900">
                {isSignUp ? "Create Workspace Account" : "Sign In to Workspace"}
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                {isSignUp
                  ? "Register to customize generation pipelines and manage private question records."
                  : "Access your personalized item-generation dashboards and validation history."}
              </p>
            </div>

            {authError && (
              <div className="bg-rose-50 border border-rose-100 text-rose-700 px-4 py-3 rounded-xl text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-500" />
                <span>{authError}</span>
              </div>
            )}

            <form onSubmit={handleAuthSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold text-slate-500">Email Address</label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="email"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    placeholder="name@company.com"
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-2.5 text-xs text-slate-800 focus:outline-none focus:border-emerald-500 focus:bg-white transition"
                    required
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold text-slate-500">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type={showPassword ? "text" : "password"}
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    placeholder="••••••••"
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-10 py-2.5 text-xs text-slate-800 focus:outline-none focus:border-emerald-500 focus:bg-white transition"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                className="w-full mt-2 bg-slate-900 hover:bg-slate-800 text-white font-semibold text-xs py-3 rounded-xl transition shadow-sm flex items-center justify-center gap-2"
              >
                {isSignUp ? "Create Account" : "Access Workspace"}
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>

            <div className="relative flex py-2 items-center">
              <div className="flex-grow border-t border-slate-150"></div>
              <span className="flex-shrink mx-4 text-[10px] text-slate-400 font-semibold uppercase tracking-wider">or</span>
              <div className="flex-grow border-t border-slate-150"></div>
            </div>

            <div className="flex flex-col gap-3 text-center">
              <button
                onClick={handleGoogleSignIn}
                type="button"
                className="w-full flex items-center justify-center gap-3 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 font-semibold text-xs py-2.5 rounded-xl transition shadow-sm cursor-pointer mb-2"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24">
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                  />
                </svg>
                Continue with Google
              </button>

              <button
                onClick={() => setIsSignUp(!isSignUp)}
                className="text-xs font-medium text-emerald-600 hover:text-emerald-700 transition"
              >
                {isSignUp ? "Already have an account? Sign In" : "New to the engine? Create an Account"}
              </button>
              <button
                onClick={() => setGuestMode(true)}
                className="text-xs font-semibold text-slate-500 hover:text-slate-700 transition underline underline-offset-4"
              >
                Continue as Guest (Read-Only Demo)
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col font-sans">

      {/* HEADER SECTION */}
      <header className="border-b border-slate-200/80 bg-white/80 backdrop-blur-md sticky top-0 z-40 px-6 py-4 grid grid-cols-[1fr_auto_1fr] items-center gap-4">

        {/* LEFT */}
        <div className="flex items-center gap-3">
          <div className="bg-emerald-50 text-emerald-600 p-2 rounded-xl border border-emerald-100">
            <Sparkles className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 flex items-center gap-2">
              SATPrep Agent Pipeline
              <span className="text-xs px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-100 rounded-full font-mono">
                v1.3 Active
              </span>
            </h1>
            <p className="text-xs text-slate-500">
              Test-Agnostic Generative Question Validator Engine
            </p>
          </div>
        </div>

        {/* CENTER */}
        <div className="flex justify-center">
          <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200">
            <button
              onClick={() => setSelectedExam("SAT")}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${selectedExam === "SAT"
                  ? "bg-white text-slate-900 shadow-sm border border-slate-200"
                  : "text-slate-500 hover:text-slate-800"
                }`}
            >
              Digital SAT Profile
            </button>

            <button
              onClick={() => setSelectedExam("GRE")}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all ${selectedExam === "GRE"
                  ? "bg-white text-slate-900 shadow-sm border border-slate-200"
                  : "text-slate-500 hover:text-slate-800"
                }`}
            >
              GRE General Profile
            </button>
          </div>
        </div>

        {/* RIGHT */}
        <div className="flex justify-end items-center gap-4 flex-wrap">
          <button
            onClick={handleResetDB}
            className="flex items-center gap-2 text-xs font-medium text-slate-600 hover:text-slate-800 bg-white border border-slate-200 hover:bg-slate-50 px-3 py-2 rounded-xl transition shadow-sm"
            title="Reseed database to default 20 questions"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset DB
          </button>

          <button
            onClick={handleExport}
            className="flex items-center gap-2 text-xs font-medium text-emerald-600 hover:text-emerald-800 bg-white border border-emerald-200 hover:bg-emerald-50 px-3 py-2 rounded-xl transition shadow-sm"
            title="Export approved questions in staging format"
          >
            <Download className="w-3.5 h-3.5" />
            Export
          </button>

          <button
            onClick={handleExportAll}
            className="flex items-center gap-2 text-xs font-medium text-indigo-600 hover:text-indigo-800 bg-white border border-indigo-200 hover:bg-indigo-50 px-3 py-2 rounded-xl transition shadow-sm"
            title="Export all questions in the bank, including their status (approved / rejected / escalated)"
          >
            <FileText className="w-3.5 h-3.5" />
            Export All
          </button>

          <div className="h-6 w-px bg-slate-200 hidden md:block"></div>

          {user ? (
            <div className="relative">
              <button
                onClick={() => setShowUserMenu((prev) => !prev)}
                className="flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 text-white font-semibold text-sm shadow-sm ring-2 ring-white hover:ring-emerald-100 hover:shadow-md hover:scale-105 transition-all"
                title={user.email ?? "Account"}
              >
                {user.email ? (
                  user.email.charAt(0).toUpperCase()
                ) : (
                  <UserIcon className="w-4 h-4" />
                )}
              </button>

              {showUserMenu && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowUserMenu(false)}
                  ></div>

                  <div className="absolute right-0 mt-2 w-56 bg-white rounded-xl border border-slate-200 shadow-lg z-20 overflow-hidden">
                    <div className="flex items-center gap-2.5 px-3 py-3 border-b border-slate-100">
                      <div className="flex items-center justify-center w-7 h-7 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 text-white font-semibold text-xs shrink-0">
                        {user.email ? (
                          user.email.charAt(0).toUpperCase()
                        ) : (
                          <UserIcon className="w-3.5 h-3.5" />
                        )}
                      </div>

                      <span className="text-xs font-medium text-slate-600 truncate">
                        {user.email}
                      </span>
                    </div>

                    <button
                      onClick={() => {
                        setShowUserMenu(false);
                        signOut(auth);
                      }}
                      className="w-full flex items-center gap-2 text-xs font-semibold text-rose-600 hover:bg-rose-50 px-3 py-2.5 transition"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      Sign Out
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 bg-amber-50 px-3 py-1.5 rounded-xl border border-amber-200">
                <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
                <span className="text-xs font-medium text-amber-700">
                  Guest (Read-Only)
                </span>
              </div>

              <button
                onClick={() => setGuestMode(false)}
                className="flex items-center gap-2 text-xs font-semibold text-emerald-600 hover:bg-emerald-50 px-3 py-1.5 rounded-xl border border-emerald-100 transition shadow-sm"
              >
                Sign In / Register
              </button>
            </div>
          )}
        </div>
      </header>

      {/* GLOBAL MESSAGES */}
      <AnimatePresence>
        {successMsg && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="bg-emerald-50 border-b border-emerald-100 text-emerald-700 px-6 py-3 text-xs flex items-center justify-between gap-2"
          >
            <span className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-emerald-500" />
              {successMsg}
            </span>
            <button onClick={() => setSuccessMsg(null)} className="hover:text-slate-900 text-emerald-600 text-sm">✕</button>
          </motion.div>
        )}
        {errorMsg && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="bg-rose-50 border-b border-rose-100 text-rose-700 px-6 py-3 text-xs flex items-center justify-between gap-2"
          >
            <span className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-500" />
              {errorMsg}
            </span>
            <button onClick={() => setErrorMsg(null)} className="hover:text-slate-900 text-rose-600 text-sm">✕</button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex flex-1 overflow-hidden">

        {/* SIDEBAR TABS selectors */}
        <aside className="w-64 border-r border-slate-200 bg-slate-100/30 p-4 flex flex-col justify-between gap-6">
          <div className="flex flex-col gap-2">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-3 mb-1">Navigation</p>

            <button
              onClick={() => handleTabChange("generate")}
              className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-xs font-medium transition ${activeTab === "generate"
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-100 shadow-sm"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
            >
              <Activity className="w-4 h-4" />
              Pipeline Orchestrator
            </button>

            <button
              onClick={() => handleTabChange("bank")}
              className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-xs font-medium transition ${activeTab === "bank"
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-100 shadow-sm"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
            >
              <DbIcon className="w-4 h-4" />
              Live Question Bank
              <span className="ml-auto bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold">
                {questionsLoaded ? questions.filter((q: Question) => q.status === "approved" || q.status === "escalated").length : "–"}
              </span>
            </button>

            <button
              onClick={() => handleTabChange("review")}
              className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-xs font-medium transition relative ${activeTab === "review"
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-100 shadow-sm"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
            >
              <UserCheck className="w-4 h-4" />
              Human Review Queue
              {escalatedQuestions.length > 0 && (
                <span className="ml-auto bg-amber-100 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold animate-pulse">
                  {escalatedQuestions.length}
                </span>
              )}
            </button>

            <button
              onClick={() => handleTabChange("analytics")}
              className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-xs font-medium transition ${activeTab === "analytics"
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-100 shadow-sm"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
            >
              <Sliders className="w-4 h-4" />
              Analytics & QA Audit
            </button>

            <button
              onClick={() => handleTabChange("docs")}
              className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-xs font-medium transition ${activeTab === "docs"
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-100 shadow-sm"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
            >
              <BookOpen className="w-4 h-4" />
              Extensibility Architecture
            </button>
          </div>

          {/* INJECTED EXAM SUMMARY INFO */}
          {config && (
            <div className="bg-white border border-slate-200 shadow-sm rounded-xl p-3 text-xs">
              <p className="font-semibold text-slate-800 mb-1">{config.name}</p>
              <p className="text-[11px] text-slate-500 leading-relaxed mb-2">{config.description}</p>
              <div className="flex flex-col gap-1 text-[10px] text-slate-500">
                <span className="flex justify-between">
                  <span>Sections:</span>
                  <span className="text-slate-800 font-mono font-medium">{config.sections.map(s => s.name.split(" ")[0]).join(", ")}</span>
                </span>
                <span className="flex justify-between">
                  <span>Min Score Target:</span>
                  <span className="text-emerald-600 font-mono font-bold">{config.validation_rubric.min_composite_score}/100</span>
                </span>
              </div>
            </div>
          )}
        </aside>

        {/* MAIN DISPLAY AREA */}
        <main className="flex-1 overflow-y-auto bg-slate-50 p-6">
          <AnimatePresence mode="wait">

            {/* 1. PIPELINE ORCHESTRATOR TAB */}
            {activeTab === "generate" && (
              <motion.div
                key="generate"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="grid grid-cols-1 lg:grid-cols-12 gap-6"
              >
                {/* PIPELINE PARAMETERS FORM */}
                <div className="lg:col-span-4 bg-white border border-slate-200/80 shadow-sm rounded-2xl p-5 flex flex-col gap-5 h-fit">
                  <div className="flex items-center gap-2 border-b border-slate-150 pb-3">
                    <Settings className="w-4 h-4 text-emerald-600" />
                    <h2 className="text-sm font-semibold text-slate-900">Target Specifications</h2>
                  </div>

                  {config ? (
                    <div className="flex flex-col gap-4">
                      {/* Top-level mode: one question from the fields below, or a batch built from combinations, or custom upload */}
                      <div className="grid grid-cols-3 gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200">
                        <button
                          onClick={() => setSpecMode("single")}
                          disabled={isGenerating || isBatchGenerating}
                          className={`py-1.5 rounded-lg text-[10px] font-semibold transition disabled:opacity-50 ${specMode === "single"
                              ? "bg-white text-slate-900 shadow-sm border border-slate-200"
                              : "text-slate-500 hover:text-slate-800"
                            }`}
                        >
                          Single
                        </button>
                        <button
                          onClick={() => setSpecMode("combinations")}
                          disabled={isGenerating || isBatchGenerating}
                          className={`py-1.5 rounded-lg text-[10px] font-semibold transition disabled:opacity-50 ${specMode === "combinations"
                              ? "bg-white text-slate-900 shadow-sm border border-slate-200"
                              : "text-slate-500 hover:text-slate-800"
                            }`}
                        >
                          Combinations
                        </button>
                        <button
                          onClick={() => setSpecMode("upload")}
                          disabled={isGenerating || isBatchGenerating}
                          className={`py-1.5 rounded-lg text-[10px] font-semibold transition disabled:opacity-50 ${specMode === "upload"
                              ? "bg-white text-slate-900 shadow-sm border border-slate-200"
                              : "text-slate-500 hover:text-slate-800"
                            }`}
                        >
                          Regeneration of Rejected Questions
                        </button>
                      </div>

                      {specMode === "single" && (
                        <div className="flex flex-col gap-4">
                          {/* Section Selector */}
                          <div className="flex flex-col gap-1.5">
                            <label className="text-[11px] font-medium text-slate-500">Exam Section</label>
                            <select
                              value={selectedSection}
                              onChange={(e) => handleSectionChange(e.target.value)}
                              disabled={isGenerating}
                              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                            >
                              {config.sections.map((sec) => (
                                <option key={sec.name} value={sec.name}>{sec.name}</option>
                              ))}
                            </select>
                          </div>

                          {/* Domain Selector */}
                          <div className="flex flex-col gap-1.5">
                            <label className="text-[11px] font-medium text-slate-500">Sub-Domain</label>
                            <select
                              value={selectedDomain}
                              onChange={(e) => handleDomainChange(e.target.value)}
                              disabled={isGenerating}
                              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                            >
                              {config.sections.find(s => s.name === selectedSection)?.domains.map((dom) => (
                                <option key={dom.name} value={dom.name}>{dom.name}</option>
                              ))}
                            </select>
                          </div>

                          {/* Skill Tag Selector */}
                          <div className="flex flex-col gap-1.5">
                            <label className="text-[11px] font-medium text-slate-500">Cognitive Skill/Concept</label>
                            <select
                              value={selectedSkill}
                              onChange={(e) => setSelectedSkill(e.target.value)}
                              disabled={isGenerating}
                              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                            >
                              {config.sections.find(s => s.name === selectedSection)
                                ?.domains.find(d => d.name === selectedDomain)
                                ?.skills.map((sk) => (
                                  <option key={sk} value={sk}>{sk}</option>
                                ))}
                            </select>
                          </div>

                          {/* Difficulty Scale */}
                          <div className="flex flex-col gap-1.5">
                            <label className="text-[11px] font-medium text-slate-500">Target Difficulty Calibration</label>
                            <div className="grid grid-cols-3 gap-2 bg-slate-100 p-1 rounded-xl border border-slate-200">
                              {config.difficulty_scale.map((diff) => (
                                <button
                                  key={diff.label}
                                  onClick={() => setSelectedDifficulty(diff.label)}
                                  disabled={isGenerating}
                                  className={`py-1.5 rounded-lg text-[10px] font-semibold transition ${selectedDifficulty === diff.label
                                      ? "bg-white text-slate-900 border border-slate-200 shadow-sm"
                                      : "text-slate-500 hover:text-slate-800"
                                    }`}
                                  title={diff.definition}
                                >
                                  {diff.label}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="flex items-center gap-2 mt-1">
                            <button
                              onClick={handleGenerate}
                              disabled={isGenerating || isBatchGenerating}
                              className="flex-1 bg-emerald-500 hover:bg-emerald-600 disabled:bg-emerald-800 disabled:text-emerald-400 text-slate-950 font-bold text-xs py-3 rounded-xl transition flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/10 cursor-pointer disabled:cursor-not-allowed"
                            >
                              {isGenerating ? (
                                <>
                                  <RefreshCw className="w-4 h-4 animate-spin" />
                                  Executing Pipeline Loops...
                                </>
                              ) : (
                                <>
                                  <Sparkles className="w-4 h-4" />
                                  Trigger Generator & Validator Loop
                                </>
                              )}
                            </button>
                            {isGenerating && (
                              <button
                                onClick={handleStopGenerate}
                                disabled={isStoppingSingle || !(activeRunIdRef.current || selectedRun?.question_id)}
                                title={!(activeRunIdRef.current || selectedRun?.question_id) ? "Waiting for the run to register before it can be stopped" : "Stop generation"}
                                className="flex items-center gap-1 text-xs font-semibold text-rose-600 border border-rose-200 bg-rose-50 hover:bg-rose-100 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-3 rounded-xl transition cursor-pointer"
                              >
                                <StopCircle className="w-4 h-4" />
                                {isStoppingSingle ? "Stopping..." : "Stop"}
                              </button>
                            )}
                          </div>
                        </div>
                      )}

                      {specMode === "combinations" && (
                        <div className="flex flex-col gap-4">
                          {/* Nested scope: every combination in the config, or a hand-picked subset */}
                          <div className="flex flex-col gap-1.5">
                            <label className="text-[11px] font-medium text-slate-500">Combination Scope</label>
                            <div className="grid grid-cols-2 gap-2 bg-slate-100 p-1 rounded-xl border border-slate-200">
                              <button
                                onClick={() => setBatchScope("all")}
                                disabled={isGenerating || isBatchGenerating}
                                className={`py-1.5 rounded-lg text-[10px] font-semibold transition disabled:opacity-50 ${batchScope === "all"
                                    ? "bg-white text-slate-900 border border-slate-200 shadow-sm"
                                    : "text-slate-500 hover:text-slate-800"
                                  }`}
                              >
                                All Combinations
                              </button>
                              <button
                                onClick={() => setBatchScope("custom")}
                                disabled={isGenerating || isBatchGenerating}
                                className={`py-1.5 rounded-lg text-[10px] font-semibold transition disabled:opacity-50 ${batchScope === "custom"
                                    ? "bg-white text-slate-900 border border-slate-200 shadow-sm"
                                    : "text-slate-500 hover:text-slate-800"
                                  }`}
                              >
                                Custom Selection
                              </button>
                            </div>
                          </div>

                          {batchScope === "custom" && (
                            <div className="flex flex-col gap-4 bg-slate-50 border border-slate-200 rounded-xl p-3">
                              {/* Sections multi-select */}
                              <div className="flex flex-col gap-1.5">
                                <div className="flex items-center justify-between">
                                  <label className="text-[11px] font-semibold text-slate-500">Sections (pick 1+)</label>
                                  <div className="flex gap-2">
                                    <button
                                      type="button"
                                      onClick={() => setBatchSections(config.sections.map(s => s.name))}
                                      disabled={isGenerating || isBatchGenerating}
                                      className="text-[10px] font-semibold text-emerald-700 hover:underline disabled:opacity-40"
                                    >
                                      Select all
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setBatchSections([])}
                                      disabled={isGenerating || isBatchGenerating}
                                      className="text-[10px] font-semibold text-slate-400 hover:underline disabled:opacity-40"
                                    >
                                      Clear
                                    </button>
                                  </div>
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {config.sections.map((sec) => {
                                    const active = batchSections.includes(sec.name);
                                    return (
                                      <button
                                        key={sec.name}
                                        onClick={() => toggleInArray(batchSections, sec.name, setBatchSections)}
                                        disabled={isGenerating || isBatchGenerating}
                                        className={`flex items-center gap-1 pl-2 pr-2.5 py-1 rounded-full text-[11px] font-semibold border transition disabled:opacity-50 ${active
                                            ? "bg-emerald-500/10 text-emerald-700 border-emerald-300"
                                            : "bg-white text-slate-500 border-slate-200 hover:border-slate-300 hover:text-slate-800"
                                          }`}
                                      >
                                        {active && <Check className="w-3 h-3" />}
                                        {sec.name}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>

                              {/* Domains multi-select — union across every selected section */}
                              <div className="flex flex-col gap-1.5">
                                <div className="flex items-center justify-between">
                                  <label className="text-[11px] font-semibold text-slate-500">Domains (pick 1+)</label>
                                  {availableDomains.length > 0 && (
                                    <div className="flex gap-2">
                                      <button
                                        type="button"
                                        onClick={() => setBatchDomains(availableDomains.map(d => d.name))}
                                        disabled={isGenerating || isBatchGenerating}
                                        className="text-[10px] font-semibold text-emerald-700 hover:underline disabled:opacity-40"
                                      >
                                        Select all
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setBatchDomains([])}
                                        disabled={isGenerating || isBatchGenerating}
                                        className="text-[10px] font-semibold text-slate-400 hover:underline disabled:opacity-40"
                                      >
                                        Clear
                                      </button>
                                    </div>
                                  )}
                                </div>
                                {availableDomains.length > 0 ? (
                                  <div className="flex flex-wrap gap-1.5">
                                    {availableDomains.map((dom) => {
                                      const active = batchDomains.includes(dom.name);
                                      return (
                                        <button
                                          key={dom.name}
                                          onClick={() => toggleInArray(batchDomains, dom.name, setBatchDomains)}
                                          disabled={isGenerating || isBatchGenerating}
                                          className={`flex items-center gap-1 pl-2 pr-2.5 py-1 rounded-full text-[11px] font-semibold border transition disabled:opacity-50 ${active
                                              ? "bg-emerald-500/10 text-emerald-700 border-emerald-300"
                                              : "bg-white text-slate-500 border-slate-200 hover:border-slate-300 hover:text-slate-800"
                                            }`}
                                        >
                                          {active && <Check className="w-3 h-3" />}
                                          {dom.name}
                                        </button>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <p className="text-[11px] text-slate-400 italic">Select a section first.</p>
                                )}
                              </div>

                              {/* Skills multi-select — union across every selected domain */}
                              <div className="flex flex-col gap-1.5">
                                <div className="flex items-center justify-between">
                                  <label className="text-[11px] font-semibold text-slate-500">Skills (pick 1+)</label>
                                  {availableSkills.length > 0 && (
                                    <div className="flex gap-2">
                                      <button
                                        type="button"
                                        onClick={() => setBatchSkills(availableSkills)}
                                        disabled={isGenerating || isBatchGenerating}
                                        className="text-[10px] font-semibold text-emerald-700 hover:underline disabled:opacity-40"
                                      >
                                        Select all
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setBatchSkills([])}
                                        disabled={isGenerating || isBatchGenerating}
                                        className="text-[10px] font-semibold text-slate-400 hover:underline disabled:opacity-40"
                                      >
                                        Clear
                                      </button>
                                    </div>
                                  )}
                                </div>
                                {availableSkills.length > 0 ? (
                                  <div className="flex flex-wrap gap-1.5">
                                    {availableSkills.map((sk) => {
                                      const active = batchSkills.includes(sk);
                                      return (
                                        <button
                                          key={sk}
                                          onClick={() => toggleInArray(batchSkills, sk, setBatchSkills)}
                                          disabled={isGenerating || isBatchGenerating}
                                          className={`flex items-center gap-1 pl-2 pr-2.5 py-1 rounded-full text-[11px] font-semibold border transition disabled:opacity-50 ${active
                                              ? "bg-emerald-500/10 text-emerald-700 border-emerald-300"
                                              : "bg-white text-slate-500 border-slate-200 hover:border-slate-300 hover:text-slate-800"
                                            }`}
                                        >
                                          {active && <Check className="w-3 h-3" />}
                                          {sk}
                                        </button>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <p className="text-[11px] text-slate-400 italic">Select a domain first.</p>
                                )}
                              </div>

                              {/* Difficulties multi-select */}
                              <div className="flex flex-col gap-1.5">
                                <div className="flex items-center justify-between">
                                  <label className="text-[11px] font-semibold text-slate-500">Difficulties (pick 1+)</label>
                                  <div className="flex gap-2">
                                    <button
                                      type="button"
                                      onClick={() => setBatchDifficulties(config.difficulty_scale.map(d => d.label))}
                                      disabled={isGenerating || isBatchGenerating}
                                      className="text-[10px] font-semibold text-emerald-700 hover:underline disabled:opacity-40"
                                    >
                                      Select all
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setBatchDifficulties([])}
                                      disabled={isGenerating || isBatchGenerating}
                                      className="text-[10px] font-semibold text-slate-400 hover:underline disabled:opacity-40"
                                    >
                                      Clear
                                    </button>
                                  </div>
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {config.difficulty_scale.map((diff) => {
                                    const active = batchDifficulties.includes(diff.label);
                                    return (
                                      <button
                                        key={diff.label}
                                        onClick={() => toggleInArray(batchDifficulties, diff.label, setBatchDifficulties)}
                                        disabled={isGenerating || isBatchGenerating}
                                        className={`flex items-center gap-1 pl-2 pr-2.5 py-1 rounded-full text-[11px] font-semibold border transition disabled:opacity-50 ${active
                                            ? "bg-emerald-500/10 text-emerald-700 border-emerald-300"
                                            : "bg-white text-slate-500 border-slate-200 hover:border-slate-300 hover:text-slate-800"
                                          }`}
                                        title={diff.definition}
                                      >
                                        {active && <Check className="w-3 h-3" />}
                                        {diff.label}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>

                              {/* Live combination count — previously the user had no idea
                                  how many pipeline runs they were about to trigger until
                                  the confirm() dialog popped up. */}
                              <div className="flex items-center justify-between bg-slate-900 text-white rounded-lg px-3 py-2 text-[11px] font-semibold">
                                <span>Questions to generate</span>
                                <span className="font-mono text-emerald-400">{customComboCount}</span>
                              </div>
                            </div>
                          )}

                          <button
                            onClick={handleBatchGenerate}
                            disabled={
                              isGenerating || isBatchGenerating ||
                              (batchScope === "custom" && (
                                batchSections.length === 0 ||
                                batchDomains.length === 0 ||
                                batchSkills.length === 0 ||
                                batchDifficulties.length === 0
                              ))
                            }
                            className="w-full mt-1 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 disabled:text-slate-500 text-white font-bold text-xs py-3 rounded-xl transition flex items-center justify-center gap-2 shadow-sm cursor-pointer disabled:cursor-not-allowed"
                          >
                            {isBatchGenerating ? (
                              <>
                                <RefreshCw className="w-4 h-4 animate-spin" />
                                {batchScope === "custom" ? "Generating Selected Combinations..." : "Generating All Combinations..."}
                              </>
                            ) : (
                              <>
                                <Sparkles className="w-4 h-4" />
                                {batchScope === "custom" ? "Generate Selected Combinations" : "Generate All Combinations"}
                              </>
                            )}
                          </button>
                          <p className="text-[10px] text-slate-400 text-center">
                            {batchScope === "custom"
                              ? "Runs the same pipeline for every selected domain/skill/difficulty combination, one at a time."
                              : `Runs the same pipeline for every domain/skill/difficulty in ${config.name}, one at a time.`}
                          </p>
                        </div>
                      )}

                      {specMode === "upload" && (
                        <div className="flex flex-col gap-4">
                          <div
                            onDragOver={handleDragOver}
                            onDragLeave={handleDragLeave}
                            onDrop={handleDrop}
                            className={`border-2 border-dashed rounded-2xl p-6 text-center cursor-pointer transition-all ${isDraggingFile
                                ? "border-emerald-500 bg-emerald-50/50"
                                : "border-slate-300 hover:border-slate-450 bg-slate-50"
                              }`}
                            onClick={() => document.getElementById("json-file-input")?.click()}
                          >
                            <input
                              type="file"
                              id="json-file-input"
                              accept=".json"
                              className="hidden"
                              onChange={handleFileUpload}
                            />
                            <div className="flex flex-col items-center gap-2">
                              <Download className="w-8 h-8 text-slate-400 rotate-180" />
                              <span className="text-xs font-semibold text-slate-700">
                                Drag & Drop Rejected Questions JSON
                              </span>
                              <span className="text-[10px] text-slate-450">
                                or click to browse files from your computer
                              </span>
                            </div>
                          </div>

                          {uploadedQuestions.length > 0 && (
                            <div className="flex flex-col gap-3">
                              <div className="flex items-center justify-between">
                                <span className="text-[11px] font-semibold text-slate-500">
                                  Questions Loaded
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setUploadedQuestions([])}
                                  className="text-[10px] text-rose-650 hover:underline font-semibold cursor-pointer"
                                >
                                  Clear
                                </button>
                              </div>
                              <div className="flex flex-col gap-2 max-h-[220px] overflow-y-auto pr-1">
                                {uploadedQuestions.map((q, idx) => {
                                  const commentsCount = Array.isArray(q.comments) ? q.comments.length : 0;
                                  return (
                                    <div
                                      key={idx}
                                      className="bg-slate-50 border border-slate-200 rounded-xl p-2.5 flex flex-col gap-1 text-[11px] text-left"
                                    >
                                      <div className="flex items-center justify-between font-semibold text-slate-700">
                                        <span className="truncate max-w-[150px]">
                                          {q.id || `Uploaded #${idx + 1}`}
                                        </span>
                                        <span className="text-[10px] px-1.5 py-0.5 rounded font-mono font-bold bg-slate-200 text-slate-600">
                                          {q.difficulty}
                                        </span>
                                      </div>
                                      <div className="text-slate-500 font-medium">
                                        {q.category} {q.subSkill ? `/ ${q.subSkill}` : ""}
                                      </div>
                                      {(q.pipelineValidatorFeedback || q.reviewerNote || commentsCount > 0) && (
                                        <div className="text-[10px] bg-amber-50 text-amber-800 border border-amber-100 rounded-lg p-1.5 mt-1 leading-relaxed max-h-[60px] overflow-y-auto">
                                          {q.pipelineValidatorFeedback && (
                                            <p className="font-semibold mb-0.5">Pipeline: {q.pipelineValidatorFeedback}</p>
                                          )}
                                          {q.reviewerNote && (
                                            <p className="italic">Reviewer: {q.reviewerNote}</p>
                                          )}
                                          {commentsCount > 0 && (
                                            <p className="text-[9px] mt-0.5">({commentsCount} human review comment(s))</p>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>

                              <button
                                onClick={handleUploadBatchGenerate}
                                disabled={isGenerating || isBatchGenerating}
                                className="w-full mt-2 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-350 disabled:text-slate-500 text-white font-bold text-xs py-3 rounded-xl transition flex items-center justify-center gap-2 shadow-sm cursor-pointer disabled:cursor-not-allowed"
                              >
                                {isBatchGenerating ? (
                                  <>
                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                    Regenerating {uploadedQuestions.length} Question(s)...
                                  </>
                                ) : (
                                  <>
                                    <Sparkles className="w-4 h-4" />
                                    Regenerate {uploadedQuestions.length} Question(s)
                                  </>
                                )}
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500 text-center py-6">Loading config...</div>
                  )}
                </div>

                {/* PIPELINE LIVE STEPPER VISUALIZATION */}
                <div className="lg:col-span-8 flex flex-col gap-5">

                  {/* Batch generation progress */}
                  {activeBatchRun && (
                    <div className="bg-white border border-slate-200/80 shadow-sm rounded-2xl p-5">
                      <div className="flex items-center justify-between border-b border-slate-150 pb-3 mb-4">
                        <div className="flex items-center gap-2">
                          <Sparkles className="w-4 h-4 text-slate-800" />
                          <h2 className="text-sm font-semibold text-slate-800">
                            Batch Generation — {batchScope === "custom" ? "Custom Selection" : "All Combinations"}
                          </h2>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] px-2 py-0.5 rounded font-mono font-semibold border ${activeBatchRun.status === "running" ? "bg-slate-100 text-slate-700 border-slate-200 animate-pulse" :
                              activeBatchRun.status === "completed" ? "bg-emerald-50 text-emerald-700 border-emerald-100" :
                                activeBatchRun.status === "completed_with_escalations" ? "bg-amber-50 text-amber-700 border-amber-100" :
                                  activeBatchRun.status === "completed_with_errors" ? "bg-amber-50 text-amber-700 border-amber-100" :
                                    activeBatchRun.status === "stopped" ? "bg-slate-100 text-slate-600 border-slate-200" :
                                      "bg-rose-50 text-rose-700 border-rose-100"
                            }`}>
                            {isStoppingBatch ? "STOPPING..." : activeBatchRun.status.replace(/_/g, " ").toUpperCase()}
                          </span>
                          {activeBatchRun.status === "running" && (
                            <button
                              onClick={() => handleStopBatch()}
                              disabled={isStoppingBatch}
                              className="flex items-center gap-1 text-[10px] font-semibold text-rose-600 border border-rose-200 bg-rose-50 hover:bg-rose-100 disabled:opacity-50 disabled:cursor-not-allowed px-2 py-0.5 rounded transition cursor-pointer"
                            >
                              <StopCircle className="w-3 h-3" />
                              {isStoppingBatch ? "Stopping..." : "Stop"}
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-3 mb-3">
                        <div className="flex-1 h-2.5 bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-slate-800 transition-all duration-500"
                            style={{ width: `${activeBatchRun.total > 0 ? ((activeBatchRun.completed + activeBatchRun.failed) / activeBatchRun.total) * 100 : 0}%` }}
                          />
                        </div>
                        <span className="text-[11px] font-mono text-slate-600 whitespace-nowrap">
                          {activeBatchRun.completed + activeBatchRun.failed}/{activeBatchRun.total}
                        </span>
                      </div>

                      <div className="flex items-center gap-4 text-[11px] text-slate-500">
                        <span className="text-emerald-600 font-semibold">{activeBatchRun.approved} approved</span>
                        {activeBatchRun.escalated > 0 && (
                          <span className="text-amber-600 font-semibold">{activeBatchRun.escalated} escalated</span>
                        )}
                        {activeBatchRun.failed > 0 && (
                          <span className="text-rose-600 font-semibold">{activeBatchRun.failed} failed</span>
                        )}
                        {activeBatchRun.status === "running" && !isStoppingBatch && (() => {
                          const current = activeBatchRun.items.find(i => i.status === "running");
                          return current ? (
                            <span className="truncate">
                              Now generating: <span className="font-medium text-slate-700">{current.domain} / {current.skill_tag} ({current.difficulty})</span>
                            </span>
                          ) : null;
                        })()}
                      </div>
                    </div>
                  )}

                  {/* Visual pipeline process stage indicators */}
                  <div className="bg-white border border-slate-200/80 shadow-sm rounded-2xl p-5">
                    <div className="flex items-center justify-between border-b border-slate-150 pb-3 mb-4">
                      <div className="flex items-center gap-2">
                        <Activity className="w-4 h-4 text-emerald-600" />
                        <h2 className="text-sm font-semibold text-slate-800">Live Pipeline Tracker</h2>
                      </div>
                      {isGenerating && (
                        <span className="flex items-center gap-1 text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-100 px-2 py-0.5 rounded font-mono animate-pulse font-semibold">
                          Running State Machine
                        </span>
                      )}
                    </div>

                    {selectedRun ? (
                      <div className="flex flex-col gap-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200 text-xs text-slate-500">
                          <div>
                            <span className="block text-[10px] text-slate-400 font-medium">Question ID</span>
                            <span className="font-mono text-slate-800 text-[11px] font-semibold">{selectedRun.question_id}</span>
                          </div>
                          <div>
                            <span className="block text-[10px] text-slate-400 font-medium">Concept / Skill</span>
                            <span className="text-slate-800 text-[11px] font-medium truncate block" title={selectedRun.skill_tag}>
                              {selectedRun.skill_tag}
                            </span>
                          </div>
                          <div>
                            <span className="block text-[10px] text-slate-400 font-medium">Current Attempt</span>
                            <span className="text-slate-800 text-[11px] font-mono font-semibold">
                              {selectedRun.current_attempt} / {selectedRun.max_attempts}
                            </span>
                          </div>
                          <div>
                            <span className="block text-[10px] text-slate-400 font-medium">Status</span>
                            <span className={`text-[11px] font-semibold ${selectedRun.status === "completed_pass" ? "text-emerald-600 font-bold" :
                                selectedRun.status === "completed_escalated" ? "text-amber-600 font-bold" :
                                  selectedRun.status === "running" ? "text-emerald-600 animate-pulse font-bold" : "text-slate-500"
                              }`}>
                              {selectedRun.status.replace("_", " ").toUpperCase()}
                            </span>
                          </div>
                        </div>

                        {/* STEP LOGS SCROLL */}
                        <div className="flex flex-col gap-3 max-h-[360px] overflow-y-auto pr-1">
                          {selectedRun.logs.map((log, idx) => {
                            let typeStyle = "bg-slate-100 text-slate-700 border-slate-200";
                            if (log.type === "draft") typeStyle = "bg-sky-50 text-sky-700 border-sky-200";
                            if (log.type === "critique") typeStyle = "bg-purple-50 text-purple-700 border-purple-200";
                            if (log.type === "finalize") typeStyle = "bg-blue-50 text-blue-700 border-blue-200";
                            if (log.type === "pre_filter") typeStyle = "bg-yellow-50 text-yellow-700 border-yellow-200";
                            if (log.type === "validate") {
                              typeStyle = log.message.includes("FAIL")
                                ? "bg-rose-50 text-rose-700 border-rose-200"
                                : "bg-emerald-50 text-emerald-700 border-emerald-200";
                            }
                            if (log.type === "decision") {
                              typeStyle = log.message.includes("approved")
                                ? "bg-emerald-100 text-emerald-800 border-emerald-200 font-bold"
                                : log.message.includes("Escalating")
                                  ? "bg-amber-100 text-amber-800 border-amber-200 font-bold"
                                  : "bg-slate-100 text-slate-700 border-slate-200";
                            }

                            return (
                              <div key={idx} className="flex gap-3 text-xs">
                                <div className="text-[10px] text-slate-400 font-mono py-1.5">{new Date(log.timestamp).toLocaleTimeString()}</div>
                                <div className="flex-1 bg-slate-50 border border-slate-200 rounded-xl p-3 flex flex-col gap-1.5">
                                  <div className="flex items-center gap-2">
                                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase border ${typeStyle}`}>
                                      {log.type}
                                    </span>
                                  </div>
                                  <p className="text-slate-700 font-sans leading-relaxed">{log.message}</p>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center py-16 text-slate-400 border border-dashed border-slate-250 rounded-xl bg-slate-50">
                        <Activity className="w-8 h-8 mb-2 text-slate-400" />
                        <p className="text-xs font-semibold text-slate-600">No active or historical pipeline log loaded.</p>
                        <p className="text-[10px] text-slate-500 mt-1">Select spec limits and hit "Trigger Loop" to generate.</p>
                      </div>
                    )}
                  </div>

                  {/* DISPLAY APPROVED/ESCALATED RUN OUTCOME IF AVAILABLE */}
                  {selectedRun && selectedRun.status !== "running" && selectedRun.final_question && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.98 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="bg-white border border-slate-200/80 shadow-sm rounded-2xl p-5"
                    >
                      <div className="flex items-center justify-between border-b border-slate-150 pb-3 mb-4">
                        <h3 className="text-sm font-semibold text-slate-900">Pipeline Result Output</h3>
                        <span className={`text-[10px] px-2.5 py-0.5 rounded-full font-bold uppercase border ${selectedRun.final_question.status === "approved"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : "bg-amber-50 text-amber-700 border-amber-200"
                          }`}>
                          {selectedRun.final_question.status}
                        </span>
                      </div>

                      <div className="flex flex-col gap-4 text-xs">
                        {selectedRun.final_question.passage && (
                          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 leading-relaxed text-slate-700 shadow-inner">
                            <span className="block text-[10px] text-slate-400 font-bold mb-1 uppercase tracking-wider">Passage</span>
                            {selectedRun.final_question.passage}
                          </div>
                        )}
                        {selectedRun.final_question.stimulus && (
                          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 leading-relaxed font-mono text-emerald-700 shadow-inner">
                            <span className="block text-[10px] text-slate-400 font-bold mb-1 uppercase tracking-wider">Stimulus</span>
                            {selectedRun.final_question.stimulus}
                          </div>
                        )}
                        <div className="p-1">
                          <span className="block text-[10px] text-slate-400 font-bold mb-1 uppercase tracking-wider">Question Text</span>
                          <p className="text-slate-900 text-sm font-semibold leading-relaxed">{selectedRun.final_question.question_text}</p>
                        </div>

                        {/* CHOICES GRID */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          {selectedRun.final_question.answer_choices.map((choice) => (
                            <div
                              key={choice.id}
                              className={`p-3 rounded-xl border flex items-center gap-3 ${choice.id === selectedRun.final_question?.correct_answer
                                  ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                                  : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100 transition"
                                }`}
                            >
                              <span className={`w-5 h-5 rounded-lg flex items-center justify-center text-[10px] font-mono font-bold ${choice.id === selectedRun.final_question?.correct_answer
                                  ? "bg-emerald-100 text-emerald-700"
                                  : "bg-slate-200 text-slate-700"
                                }`}>
                                {choice.id}
                              </span>
                              <span>{choice.text}</span>
                            </div>
                          ))}
                        </div>

                        {selectedRun.final_question.validation && (
                          <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl flex flex-col gap-3 shadow-inner">
                            <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                              <span className="font-semibold uppercase tracking-wider text-slate-500 text-[10px]">Validation Rubric Scores</span>
                              <span className="font-bold text-emerald-600">{selectedRun.final_question.validation.validation_status}</span>
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                              {Object.entries(selectedRun.final_question.validation.checks).map(([checkName, checkVal]) => {
                                const displayValue = formatRubricCheckValue(checkVal);
                                return (
                                  <div key={checkName} className="flex justify-between items-center bg-white p-2 rounded border border-slate-200 shadow-sm text-[10px] font-mono">
                                    <span className="capitalize text-slate-600">{checkName.replace("_", " ")}</span>
                                    <span className={`font-bold ${displayValue.startsWith("PASS") ? "text-emerald-600" : "text-rose-600"}`}>
                                      {displayValue}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* EXPLANATION / RATIONALES */}
                        <div className="bg-emerald-50 border border-emerald-100 p-4 rounded-xl flex flex-col gap-2 shadow-sm">
                          <span className="block text-[10px] text-emerald-700 font-bold uppercase tracking-wider">Correct Answer Rationale</span>
                          <p className="text-slate-700 leading-relaxed">{selectedRun.final_question.explanation.correct_rationale}</p>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </div>
              </motion.div>
            )}

            {/* 2. LIVE QUESTION BANK EXPLORER */}
            {activeTab === "bank" && (
              <motion.div
                key="bank"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="flex flex-col gap-5"
              >
                {/* SEARCH AND FILTERS PANEL */}
                <div className="bg-white border border-slate-200/80 shadow-sm rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4">
                  <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[280px]">
                    <div className="relative flex-1 max-w-sm">
                      <input
                        type="text"
                        placeholder="Search question content, skill tags, passages..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-4 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-emerald-500 focus:bg-white transition"
                      />
                      <Filter className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-3" />
                    </div>

                    {/* Status filter */}
                    <select
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                      className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-emerald-500 focus:bg-white transition"
                    >
                      <option value="all">All Statuses</option>
                      <option value="approved">Approved</option>
                      <option value="escalated">Escalated</option>
                      <option value="rejected">Rejected</option>
                    </select>

                    {/* Domain filter */}
                    {config && (
                      <select
                        value={domainFilter}
                        onChange={(e) => setDomainFilter(e.target.value)}
                        className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-emerald-500 focus:bg-white transition"
                      >
                        <option value="all">All Domains</option>
                        {config.sections.flatMap(s => s.domains).map(dom => (
                          <option key={dom.name} value={dom.name}>{dom.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>

                {/* QUESTIONS LIST */}
                {filteredQuestions.length > 0 ? (
                  <div className="flex flex-col gap-4">
                    {paginatedBankQuestions.map((q) => (
                      <div
                        key={q.question_id}
                        className="bg-white border border-slate-200/85 hover:border-slate-300 rounded-2xl p-5 flex flex-col gap-4 transition shadow-sm"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-150 pb-3">
                          <div className="flex items-center gap-3">
                            <span className="font-mono text-[11px] font-bold text-slate-700 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">
                              {q.question_id}
                            </span>
                            <span className="text-xs text-slate-500">
                              {q.section} • <span className="font-semibold text-slate-700">{q.skill_tag}</span>
                            </span>
                            <span className="text-[10px] font-bold bg-slate-100 text-slate-600 px-2 py-0.5 rounded border border-slate-200">
                              {q.difficulty}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            {q.similarity_score > 0.85 && (
                              <span className="text-[9px] bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full font-mono flex items-center gap-1 font-bold animate-pulse">
                                <AlertTriangle className="w-3 h-3" />
                                Similarity Alert ({q.similarity_score})
                              </span>
                            )}
                            <span className={`text-[10px] px-2.5 py-0.5 rounded-full font-bold uppercase border ${q.status === "approved" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                                q.status === "escalated" ? "bg-amber-50 text-amber-700 border-amber-200" :
                                  "bg-rose-50 text-rose-700 border-rose-200"
                              }`}>
                              {q.status}
                            </span>
                            {q.status === "rejected" && (
                              <button
                                onClick={() => handleRegenerate(q)}
                                disabled={regeneratingIds.has(q.question_id)}
                                title="Send this question back to the Generator Agent for a fresh attempt"
                                className="text-[10px] bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 px-2.5 py-0.5 rounded-full font-bold uppercase flex items-center gap-1 transition disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <RefreshCw className={`w-3 h-3 ${regeneratingIds.has(q.question_id) ? "animate-spin" : ""}`} />
                                {regeneratingIds.has(q.question_id) ? "Regenerating..." : "Regenerate"}
                              </button>
                            )}
                          </div>
                        </div>

                        {/* CONTENT VIEW */}
                        <div className="text-xs flex flex-col gap-3">
                          {q.passage && (
                            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 leading-relaxed text-slate-700 font-sans shadow-inner">
                              {q.passage}
                            </div>
                          )}
                          {q.stimulus && (
                            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 font-mono text-emerald-700 whitespace-pre-wrap shadow-inner">
                              {q.stimulus}
                            </div>
                          )}
                          <p className="text-slate-900 text-sm font-semibold leading-relaxed pr-10">{q.question_text}</p>

                          {/* OPTIONS ROW */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
                            {q.answer_choices.map((choice) => (
                              <div
                                key={choice.id}
                                className={`p-3 rounded-xl border flex items-center gap-3 ${choice.id === q.correct_answer
                                    ? "bg-emerald-50 border-emerald-200 text-emerald-850"
                                    : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100 transition"
                                  }`}
                              >
                                <span className={`w-5 h-5 rounded-lg flex items-center justify-center text-[10px] font-mono font-bold ${choice.id === q.correct_answer
                                    ? "bg-emerald-100 text-emerald-700"
                                    : "bg-slate-200 text-slate-700"
                                  }`}>
                                  {choice.id}
                                </span>
                                <span className="text-xs font-medium">{choice.text}</span>
                              </div>
                            ))}
                          </div>

                          {/* EXPANDABLE QA CHECKS DETAILS */}
                          {q.validation && (
                            <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl flex flex-col gap-3 shadow-inner">
                              <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                                <span className="text-[10px] font-bold uppercase text-slate-500 tracking-wider">Independent QA Audit Report</span>
                                <span className="text-slate-600 font-mono font-bold text-[11px]">
                                  Accuracy Rating: <span className="text-emerald-600 font-bold">{q.validation.accuracy_score}/100</span>
                                </span>
                              </div>
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] text-slate-600 font-mono">
                                {Object.entries(q.validation.checks).map(([checkName, checkVal]) => {
                                  const displayValue = formatRubricCheckValue(checkVal);
                                  return (
                                    <div key={checkName} className="flex justify-between items-center bg-white p-2 rounded border border-slate-200 shadow-sm">
                                      <span className="capitalize">{checkName.replace("_", " ")}</span>
                                      <span className={`font-bold ${displayValue.startsWith("PASS") ? "text-emerald-600 font-bold" : "text-rose-600 font-bold"}`}>
                                        {displayValue}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                              <div className="text-[11px] text-slate-650 pt-1 leading-relaxed">
                                <span className="font-semibold block text-slate-500 mb-0.5">Audit Feedback:</span>
                                {q.validation.feedback}
                              </div>
                            </div>
                          )}

                          {/* EXPLANATIONS */}
                          <div className="bg-emerald-50 border border-emerald-100/60 p-4 rounded-xl text-[11px] flex flex-col gap-2 leading-relaxed shadow-sm">
                            <p className="text-slate-700">
                              <strong className="text-emerald-800 mr-1.5 uppercase font-bold text-[10px] tracking-wider block mb-1">Correct Answer Explanation:</strong>
                              {q.explanation.correct_rationale}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-20 text-slate-400 border border-dashed border-slate-200 rounded-2xl bg-white shadow-sm">
                    <DbIcon className="w-8 h-8 mb-2 text-slate-400" />
                    <p className="text-xs font-semibold text-slate-600">No questions matched the filter criteria in the live bank.</p>
                  </div>
                )}

                {/* PAGINATION CONTROLS */}
                {filteredQuestions.length > BANK_PAGE_SIZE && (
                  <div className="flex items-center justify-between bg-white border border-slate-200/80 shadow-sm rounded-2xl px-4 py-3">
                    <span className="text-xs text-slate-500">
                      Showing <span className="font-semibold text-slate-700">{currentBankPage * BANK_PAGE_SIZE + 1}</span>
                      –<span className="font-semibold text-slate-700">{Math.min((currentBankPage + 1) * BANK_PAGE_SIZE, filteredQuestions.length)}</span>
                      {" "}of <span className="font-semibold text-slate-700">{filteredQuestions.length}</span> questions
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setBankPage(p => Math.max(0, p - 1))}
                        disabled={currentBankPage === 0}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
                      >
                        Previous
                      </button>
                      <span className="text-xs text-slate-500 font-mono">
                        Page {currentBankPage + 1} / {bankPageCount}
                      </span>
                      <button
                        onClick={() => setBankPage(p => Math.min(bankPageCount - 1, p + 1))}
                        disabled={currentBankPage >= bankPageCount - 1}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </motion.div>
            )}

            {/* 3. HUMAN REVIEW QUEUE TAB */}
            {activeTab === "review" && (
              <motion.div
                key="review"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="grid grid-cols-1 lg:grid-cols-12 gap-6"
              >
                {/* LIST OF ESCALATED QUESTIONS */}
                <div className="lg:col-span-5 bg-white border border-slate-200/80 shadow-sm rounded-2xl p-5 flex flex-col gap-4">
                  <div className="flex items-center gap-2 border-b border-slate-150 pb-3">
                    <UserCheck className="w-4 h-4 text-amber-500" />
                    <h2 className="text-sm font-semibold text-slate-800">Escalated Failures ({escalatedQuestions.length})</h2>
                  </div>

                  {escalatedQuestions.length > 0 ? (
                    <div className="flex flex-col gap-3 overflow-y-auto max-h-[500px]">
                      {escalatedQuestions.map((q) => (
                        <button
                          key={q.question_id}
                          onClick={() => {
                            setReviewQuestion(q);
                            setIsEditing(false);
                            setReviewFeedback("");
                          }}
                          className={`w-full text-left p-4 rounded-xl border transition shadow-sm ${reviewQuestion?.question_id === q.question_id
                              ? "bg-amber-50 border-amber-300 text-amber-900 font-medium"
                              : "bg-slate-50 border-slate-200 hover:bg-slate-100"
                            }`}
                        >
                          <div className="flex justify-between items-center gap-2 mb-2">
                            <span className="font-mono text-xs font-bold text-slate-800">{q.question_id}</span>
                            <span className="text-[10px] bg-amber-100 text-amber-800 border border-amber-200 px-1.5 py-0.5 rounded font-mono font-semibold">
                              Attempt {q.generation_attempt} Failed
                            </span>
                          </div>
                          <p className="text-xs text-slate-500 line-clamp-2 leading-relaxed mb-2">{q.question_text}</p>
                          <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono">
                            <span>{q.skill_tag}</span>
                            <span className="text-rose-600 font-bold">Score: {q.validation?.accuracy_score || 0}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-20 text-slate-400 border border-dashed border-slate-200 rounded-xl bg-slate-50">
                      <CheckCircle className="w-8 h-8 mb-2 text-emerald-500/40" />
                      <p className="text-xs font-semibold text-slate-600">No questions escalated for human review!</p>
                      <p className="text-[10px] text-slate-500 mt-1">All pipeline generated items met the composite accuracy score criteria.</p>
                    </div>
                  )}
                </div>

                {/* ACTIVE REVIEW PANEL */}
                <div className="lg:col-span-7">
                  {reviewQuestion ? (
                    <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5 flex flex-col gap-5">
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-150 pb-3">
                        <div>
                          <h3 className="text-sm font-semibold text-slate-800">Reviewing Escalated {reviewQuestion.question_id}</h3>
                          <p className="text-[10px] text-slate-500 mt-0.5">{reviewQuestion.section} • {reviewQuestion.skill_tag}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => startEditing(reviewQuestion)}
                            className="flex items-center gap-1.5 text-[11px] bg-slate-50 hover:bg-slate-100 border border-slate-200 px-2.5 py-1.5 rounded-lg text-slate-700 transition font-semibold shadow-sm"
                          >
                            <Edit3 className="w-3 h-3 text-slate-500" />
                            Correct / Edit Question
                          </button>
                        </div>
                      </div>

                      {/* VALIDATION REJECTION REASON */}
                      {reviewQuestion.validation && (
                        <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-xs text-rose-800">
                          <div className="flex items-center gap-2 font-bold mb-1">
                            <AlertCircle className="w-4 h-4 text-rose-600 animate-pulse" />
                            <span>Why the independent validator rejected:</span>
                          </div>
                          <p className="leading-relaxed text-slate-700">{reviewQuestion.validation.feedback}</p>
                          {reviewQuestion.validation.independent_derivation && (
                            <div className="mt-3 bg-white border border-rose-100 rounded-xl p-3 text-slate-700">
                              <div className="text-[10px] uppercase tracking-wider font-semibold mb-2 text-rose-700">
                                Validator's Independent Derivation
                              </div>
                              <p className="leading-relaxed text-slate-600 text-xs whitespace-pre-wrap">
                                {reviewQuestion.validation.independent_derivation}
                              </p>
                            </div>
                          )}
                          {reviewQuestion.validation.revised_suggestion && (
                            <div className="mt-2 text-slate-500 italic font-medium">
                              <strong>Suggestion:</strong> {reviewQuestion.validation.revised_suggestion}
                            </div>
                          )}
                          <div className="mt-4 bg-white border border-rose-100 rounded-xl p-3 text-slate-700">
                            <div className="flex items-center justify-between mb-3">
                              <span className="text-[10px] uppercase tracking-wider font-semibold">Validation Rubric Details</span>
                              <span className="text-rose-700 font-bold">{reviewQuestion.validation.validation_status}</span>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
                              {Object.entries(reviewQuestion.validation.checks).map(([checkName, checkVal]) => {
                                const displayValue = formatRubricCheckValue(checkVal);
                                return (
                                  <div key={checkName} className="flex justify-between items-center rounded-lg border border-slate-200 bg-slate-50 px-2 py-2">
                                    <span className="capitalize">{checkName.replace("_", " ")}</span>
                                    <span className={`font-bold ${displayValue.startsWith("PASS") ? "text-emerald-600" : "text-rose-600"}`}>
                                      {displayValue}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* THE QUESTION DETAILS */}
                      {!isEditing ? (
                        <div className="text-xs flex flex-col gap-4">
                          {reviewQuestion.passage && (
                            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 leading-relaxed text-slate-700 font-sans shadow-inner">
                              <span className="block text-[10px] text-slate-400 font-bold mb-1 uppercase tracking-wider">Passage</span>
                              {reviewQuestion.passage}
                            </div>
                          )}
                          {reviewQuestion.stimulus && (
                            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 leading-relaxed font-mono text-emerald-700 shadow-inner">
                              <span className="block text-[10px] text-slate-400 font-bold mb-1 uppercase tracking-wider">Stimulus</span>
                              {reviewQuestion.stimulus}
                            </div>
                          )}
                          <div>
                            <span className="block text-[10px] text-slate-400 font-bold mb-1 uppercase tracking-wider">Question Text</span>
                            <p className="text-slate-900 text-sm font-bold leading-relaxed">{reviewQuestion.question_text}</p>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            {reviewQuestion.answer_choices.map((choice) => (
                              <div
                                key={choice.id}
                                className={`p-3 rounded-xl border flex items-center gap-3 shadow-sm ${choice.id === reviewQuestion.correct_answer
                                    ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                                    : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100 transition"
                                  }`}
                              >
                                <span className={`w-5 h-5 rounded-lg flex items-center justify-center text-[10px] font-mono font-bold ${choice.id === reviewQuestion.correct_answer
                                    ? "bg-emerald-100 text-emerald-700"
                                    : "bg-slate-200 text-slate-700"
                                  }`}>
                                  {choice.id}
                                </span>
                                <span className="font-medium">{choice.text}</span>
                              </div>
                            ))}
                          </div>

                          {/* ACTION BUTTONS (APPROVE / REJECT OVERRIDE) */}
                          <div className="border-t border-slate-150 pt-4 mt-2 flex flex-col gap-4">
                            <div className="flex flex-col gap-1.5">
                              <label className="text-[11px] font-medium text-slate-500">Add Review Comments / Overriding Rationale</label>
                              <textarea
                                value={reviewFeedback}
                                onChange={(e) => setReviewFeedback(e.target.value)}
                                placeholder="Explain why you are manually approving or rejecting this question..."
                                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-emerald-500 focus:bg-white transition min-h-[60px]"
                              />
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleReviewAction("approve")}
                                className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white font-bold text-xs py-2.5 rounded-xl transition flex items-center justify-center gap-1.5 cursor-pointer shadow-sm"
                              >
                                <Check className="w-4 h-4" />
                                Approve Override (Force Live)
                              </button>
                              <button
                                onClick={() => handleReviewAction("reject")}
                                className="bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-bold text-xs px-4 py-2.5 rounded-xl transition flex items-center justify-center gap-1.5 cursor-pointer shadow-sm"
                              >
                                <X className="w-4 h-4" />
                                Reject Permanently
                              </button>
                              <button
                                onClick={handleRejectAndRegenerate}
                                disabled={regeneratingIds.has(reviewQuestion.question_id)}
                                title="Reject this question and immediately send it back to the Generator Agent for a fresh attempt, using this feedback"
                                className="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 font-bold text-xs px-4 py-2.5 rounded-xl transition flex items-center justify-center gap-1.5 cursor-pointer shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <RefreshCw className={`w-4 h-4 ${regeneratingIds.has(reviewQuestion.question_id) ? "animate-spin" : ""}`} />
                                {regeneratingIds.has(reviewQuestion.question_id) ? "Regenerating..." : "Reject & Regenerate"}
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        /* EDIT FORM */
                        <div className="text-xs flex flex-col gap-4">
                          {reviewQuestion.passage !== null && (
                            <div className="flex flex-col gap-1.5">
                              <label className="text-[11px] font-medium text-slate-500">Passage</label>
                              <textarea
                                value={editPassage}
                                onChange={(e) => setEditPassage(e.target.value)}
                                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-emerald-500 focus:bg-white transition min-h-[100px] leading-relaxed"
                              />
                            </div>
                          )}

                          {reviewQuestion.stimulus !== null && (
                            <div className="flex flex-col gap-1.5">
                              <label className="text-[11px] font-medium text-slate-500">Stimulus</label>
                              <textarea
                                value={editStimulus}
                                onChange={(e) => setEditStimulus(e.target.value)}
                                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono text-emerald-700 focus:outline-none focus:border-emerald-500 focus:bg-white transition min-h-[60px]"
                              />
                            </div>
                          )}

                          <div className="flex flex-col gap-1.5">
                            <label className="text-[11px] font-medium text-slate-500">Question Text</label>
                            <textarea
                              value={editQuestionText}
                              onChange={(e) => setEditQuestionText(e.target.value)}
                              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-emerald-500 focus:bg-white transition min-h-[60px]"
                            />
                          </div>

                          {/* CHOICES EDITOR */}
                          <div className="flex flex-col gap-2">
                            <label className="text-[11px] font-medium text-slate-500">Answer Choices</label>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                              {editChoices.map((choice, idx) => (
                                <div key={choice.id} className="bg-slate-50 p-2 rounded-xl border border-slate-200 flex items-center gap-2 focus-within:bg-white transition shadow-sm">
                                  <span className={`w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-mono font-bold ${choice.id === editCorrectAnswer ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-700"
                                    }`}>
                                    {choice.id}
                                  </span>
                                  <input
                                    type="text"
                                    value={choice.text}
                                    onChange={(e) => updateChoiceText(idx, e.target.value)}
                                    className="flex-1 bg-transparent text-xs text-slate-800 focus:outline-none"
                                  />
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-4">
                            {/* Correct Answer Selection */}
                            <div className="flex flex-col gap-1.5">
                              <label className="text-[11px] font-medium text-slate-500">Correct Answer</label>
                              <select
                                value={editCorrectAnswer}
                                onChange={(e) => setEditCorrectAnswer(e.target.value)}
                                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-850 focus:outline-none focus:border-emerald-500 focus:bg-white transition"
                              >
                                {editChoices.map(c => (
                                  <option key={c.id} value={c.id}>Option {c.id}</option>
                                ))}
                              </select>
                            </div>
                          </div>

                          <div className="flex flex-col gap-1.5">
                            <label className="text-[11px] font-medium text-slate-500">Explanation / Rationale</label>
                            <textarea
                              value={editExplanation}
                              onChange={(e) => setEditExplanation(e.target.value)}
                              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-emerald-500 focus:bg-white transition min-h-[80px]"
                            />
                          </div>

                          {/* ACTION BUTTONS */}
                          <div className="border-t border-slate-150 pt-4 flex gap-2">
                            <button
                              onClick={() => handleReviewAction("edit")}
                              className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white font-bold text-xs py-2.5 rounded-xl transition flex items-center justify-center gap-1.5 cursor-pointer shadow-sm"
                            >
                              <Check className="w-4 h-4" />
                              Save Corrected Question (Approve)
                            </button>
                            <button
                              onClick={() => setIsEditing(false)}
                              className="bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-200 font-bold text-xs px-4 py-2.5 rounded-xl transition cursor-pointer shadow-sm"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-24 text-slate-400 border border-dashed border-slate-250 rounded-2xl bg-white shadow-sm">
                      <UserCheck className="w-8 h-8 mb-2 text-slate-400" />
                      <p className="text-xs font-semibold text-slate-600">Select an escalated question to review the validation failures.</p>
                      <p className="text-[10px] text-slate-500 mt-1">You will be able to override, reject, or edit content inline.</p>
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {/* 4. ANALYTICS & QA AUDIT LOGS TAB */}
            {activeTab === "analytics" && (
              <motion.div
                key="analytics"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="flex flex-col gap-6"
              >
                {/* METRICS ROW */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5 flex flex-col gap-1">
                    <span className="text-[11px] text-slate-400 font-bold uppercase tracking-wider">Accumulated Run Pass Rate</span>
                    <div className="flex items-baseline gap-2">
                      <span className="text-3xl font-extrabold text-slate-800 font-mono">{passRate}%</span>
                      <span className="text-xs text-emerald-600 font-bold">({passedLogs}/{totalLogs} validations)</span>
                    </div>
                    <div className="w-full bg-slate-100 h-1.5 rounded-full mt-3 overflow-hidden border border-slate-200">
                      <div className="bg-emerald-500 h-full" style={{ width: `${passRate}%` }} />
                    </div>
                  </div>

                  <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5 flex flex-col gap-1">
                    <span className="text-[11px] text-slate-400 font-bold uppercase tracking-wider">Similarity Alerts Flagged</span>
                    <div className="flex items-baseline gap-2">
                      <span className="text-3xl font-extrabold text-amber-600 font-mono">{highSimilarityAlerts}</span>
                      <span className="text-xs text-slate-500">originality alerts flagged</span>
                    </div>
                    <p className="text-[10px] text-slate-400 mt-2">Similarity threshold default set to &gt;0.85 cosine overlap.</p>
                  </div>

                  <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5 flex flex-col gap-1">
                    <span className="text-[11px] text-slate-400 font-bold uppercase tracking-wider">Audit Traceability logs</span>
                    <div className="flex items-baseline gap-2">
                      <span className="text-3xl font-extrabold text-slate-800 font-mono">{totalLogs}</span>
                      <span className="text-xs text-slate-500">stored verification snapshots</span>
                    </div>
                    <p className="text-[10px] text-slate-400 mt-2">Every validation run logged with multi-dimension criteria scores.</p>
                  </div>
                </div>

                {/* DETAILED Snapshots snapshots */}
                <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5">
                  <div className="flex items-center justify-between border-b border-slate-150 pb-3 mb-4">
                    <h3 className="text-sm font-semibold text-slate-800">Traceability Audit Trail</h3>
                    <span className="text-[10px] text-slate-450">Chronological history of all pipeline runs</span>
                  </div>

                  {auditLogs.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs border-collapse">
                        <thead>
                          <tr className="text-slate-400 border-b border-slate-150">
                            <th className="pb-2 font-semibold">Time</th>
                            <th className="pb-2 font-semibold">Question ID</th>
                            <th className="pb-2 font-semibold">Skill Concept</th>
                            <th className="pb-2 font-semibold text-center">Attempt</th>
                            <th className="pb-2 font-semibold text-center">QA Status</th>
                            <th className="pb-2 font-semibold text-center">Score</th>
                            <th className="pb-2 font-semibold">Actionable Audit Comments</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {auditLogs.map((log) => (
                            <tr key={log.id} className="text-slate-600 hover:bg-slate-50/50">
                              <td className="py-2.5 font-mono text-[10px] text-slate-400">
                                {new Date(log.timestamp).toLocaleTimeString()}
                              </td>
                              <td className="py-2.5 font-mono text-[11px] font-semibold text-slate-800">
                                {log.question_id}
                              </td>
                              <td className="py-2.5 max-w-[150px] truncate" title={log.skill_tag}>
                                {log.skill_tag}
                              </td>
                              <td className="py-2.5 text-center font-mono text-slate-500">
                                {log.generation_attempt}
                              </td>
                              <td className="py-2.5 text-center">
                                <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${log.validation_status === "PASS"
                                    ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                    : "bg-rose-50 text-rose-700 border border-rose-200"
                                  }`}>
                                  {log.validation_status}
                                </span>
                              </td>
                              <td className="py-2.5 text-center font-mono font-bold text-slate-800">
                                {log.accuracy_score}
                              </td>
                              <td className="py-2.5 text-slate-500 max-w-[280px] truncate" title={log.feedback}>
                                {log.feedback}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="text-center py-10 text-slate-400 text-xs">No audit logs available yet.</div>
                  )}
                </div>
              </motion.div>
            )}

            {/* 5. HOW TO EXTEND ARCHITECTURE TAB */}
            {activeTab === "docs" && (
              <motion.div
                key="docs"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="grid grid-cols-1 md:grid-cols-2 gap-6"
              >
                {/* ARCHITECTURE GUIDE */}
                <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5 flex flex-col gap-4">
                  <div className="flex items-center gap-2 border-b border-slate-150 pb-3">
                    <BookOpen className="w-4 h-4 text-emerald-600" />
                    <h2 className="text-sm font-semibold text-slate-800">Test-Agnostic Design Principles</h2>
                  </div>

                  <div className="text-xs text-slate-600 flex flex-col gap-3.5 leading-relaxed">
                    <p>
                      This pipeline is designed specifically with **zero hardcoded exam branching logic**. The orchestrator,
                      generator, and validator pull every parameter (domains, skills, rubrics, rules) dynamically at runtime
                      from a **Test Profile Configuration** JSON schema.
                    </p>

                    <div>
                      <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">How to Add a New Exam (e.g. GRE/JEE/GMAT)</h4>
                      <ol className="list-decimal list-inside space-y-2 text-slate-550 pl-1">
                        <li>
                          Create a new configuration JSON file in the <code className="text-slate-800 font-mono bg-slate-100 border border-slate-200 px-1 py-0.5 rounded">/configs/</code> folder
                          (e.g. <code className="text-emerald-700 font-mono bg-slate-100 border border-slate-200 px-1 py-0.5 rounded font-semibold">gre.json</code>).
                        </li>
                        <li>
                          Configure the <code className="text-slate-800 font-mono bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded">sections</code> array with corresponding domains and sub-skills.
                        </li>
                        <li>
                          Define custom <code className="text-slate-800 font-mono bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded">style_rules</code> (e.g. Quantitative Comparison format constraints).
                        </li>
                        <li>
                          Provide specific weights and threshold limits under the <code className="text-slate-800 font-mono bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded">validation_rubric</code> layer.
                        </li>
                        <li>
                          The orchestrator reads your new config instantly. No prompt, agent logic, or code changes required!
                        </li>
                      </ol>
                    </div>

                    <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 flex flex-col gap-2 shadow-inner">
                      <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Common Question Schema</span>
                      <p className="text-slate-600 text-[11px]">
                        The database preserves a unified question shape across all exams.
                        Custom attributes (e.g., multi-correct options, AWA rubrics) are safely stored in <code className="text-slate-800 font-mono bg-slate-100 border border-slate-200 px-1 rounded">metadata.exam_specific</code> to ensure seamless cross-exam scaling.
                      </p>
                    </div>
                  </div>
                </div>

                {/* DYNAMIC JSON CONFIG DISPLAY */}
                <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5 flex flex-col gap-4">
                  <div className="flex items-center justify-between border-b border-slate-150 pb-3">
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-emerald-600" />
                      <h2 className="text-sm font-semibold text-slate-800">gre.json Extensibility proof</h2>
                    </div>
                    <span className="text-[9px] bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded font-mono border border-emerald-200 font-bold">
                      extensible config stub
                    </span>
                  </div>

                  <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 max-h-[440px] overflow-y-auto font-mono text-[10.5px] text-emerald-800 leading-normal shadow-inner">
                    <pre>{`{
  "exam_type": "GRE",
  "name": "GRE General Test",
  "sections": [
    {
      "name": "Verbal Reasoning",
      "question_formats": ["MCQ 5-option", "Text Completion"],
      "domains": [
        {
          "name": "Text Completion",
          "skills": ["Single-blank", "Double-blank", "Triple-blank"]
        }
      ]
    },
    {
      "name": "Quantitative Reasoning",
      "question_formats": ["Quantitative Comparison", "Numeric Entry"],
      "domains": [
        {
          "name": "Algebra",
          "skills": ["Quadratic equations", "Coordinate geometry"]
        }
      ]
    }
  ],
  "validation_rubric": {
    "min_composite_score": 90,
    "checks": [
      { "id": "correctness", "weight": 25 },
      { "id": "distractor_quality", "weight": 20 }
    ]
  }
}`}</pre>
                  </div>
                </div>
              </motion.div>
            )}

          </AnimatePresence>
        </main>
      </div>

      {/* FOOTER STATS */}
      <footer className="border-t border-slate-200 bg-slate-50 px-6 py-3 text-slate-400 flex justify-between items-center text-[10px] font-mono">
        <span></span>
        <span></span>
      </footer>

    </div>
  );
}