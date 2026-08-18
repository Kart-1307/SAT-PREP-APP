import { Question } from "../types.js";

export const SEED_QUESTIONS: Question[] = [
  {
    question_id: "sat-rw-cs-0001",
    exam_type: "SAT",
    section: "Reading and Writing",
    domain: "Craft and Structure",
    skill_tag: "Words in Context",
    difficulty: "Medium",
    passage_intro: "The following passage is adapted from a film commentary published in a 2021 arts journal.",
    passage: "The critic's review of the director's new film was surprisingly warm, characterizing it not as a ________ departure from his earlier, more aggressive style, but rather as a natural, gentle evolution of his thematic interests.",
    stimulus: null,
    question_text: "Which choice completes the text with the most logical and precise word or phrase?",
    answer_choices: [
      { id: "A", text: "gradual" },
      { id: "B", text: "abrupt" },
      { id: "C", text: "predictable" },
      { id: "D", text: "welcome" }
    ],
    correct_answer: "B",
    explanation: {
      correct_rationale: "The passage sets up a contrast between a 'departure' and a 'natural, gentle evolution.' A contrast to a 'gentle evolution' would be a sudden, sharp departure. 'Abrupt' perfectly captures this sense of suddenness and lack of transition, contrasting with 'gentle evolution.'",
      distractor_rationale: {
        "A": "'Gradual' is a synonym for slow or step-by-step, which aligns with 'evolution' rather than contrasting with it.",
        "C": "'Predictable' departure does not fit the contrast of suddenness established by 'surprisingly warm' and 'gentle evolution.'",
        "D": "'Welcome' contradicts the idea of an aggressive style vs surprisingly warm evolution."
      }
    },
    similarity_score: 0.15,
    similar_question_id: null,
    generation_attempt: 1,
    validation: {
      validation_status: "PASS",
      accuracy_score: 95,
      checks: {
        correctness: "PASS",
        distractor_quality: "PASS",
        clarity: "PASS",
        difficulty_alignment: "PASS",
        domain_skill_alignment: "PASS",
        originality: "PASS",
        bias_sensitivity: "PASS"
      },
      feedback: "Excellent word-in-context question with clear contrast indicators and highly plausible distractors."
    },
    metadata: { created_at: "2026-06-23T20:10:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "approved"
  },
  {
    question_id: "sat-rw-cs-0002",
    exam_type: "SAT",
    section: "Reading and Writing",
    domain: "Craft and Structure",
    skill_tag: "Text Structure and Purpose",
    difficulty: "Hard",
    passage_intro: "The following excerpt is from Virginia Woolf's 1923 essay 'The Modern Novel.'",
    passage: "In her 1923 essay 'The Modern Novel,' Virginia Woolf argues against the materialist writers of her day, claiming they write of unimportant things and spend immense skill making the trivial and the transitory appear true and enduring. Woolf asserts that a novel should instead capture the fleeting, unrecorded thoughts of the human mind. Rather than adhering to a strict external realism, she contends, literature must turn inward to represent the luminous halo of life itself.",
    stimulus: null,
    question_text: "Which choice best describes the main purpose of the text?",
    answer_choices: [
      { id: "A", text: "To argue that modern materialist writers lack the technical skill to capture reality." },
      { id: "B", text: "To advocate for a shift in literary focus from external material details to internal subjective experience." },
      { id: "C", text: "To criticize Virginia Woolf's contemporaries for failing to address important socio-political issues." },
      { id: "D", text: "To demonstrate how historical realism in the early 20th century failed to reflect objective truths." }
    ],
    correct_answer: "B",
    explanation: {
      correct_rationale: "The passage describes Woolf's argument that literature should focus on 'the fleeting, unrecorded thoughts of the human mind' (inward) rather than 'strict external realism' (external material details). This directly supports option B.",
      distractor_rationale: {
        "A": "The text states that materialists spend 'immense skill,' so they do not lack technical skill.",
        "C": "Woolf criticizes them for focusing on external material details, not for avoiding socio-political issues.",
        "D": "The focus is on subjective experience (Woolf's prescription), not a failure of historical realism to reflect objective truths."
      }
    },
    similarity_score: 0.22,
    similar_question_id: null,
    generation_attempt: 1,
    validation: {
      validation_status: "PASS",
      accuracy_score: 98,
      checks: { correctness: "PASS", distractor_quality: "PASS", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "PASS", bias_sensitivity: "PASS" },
      feedback: "High-quality passage mimicking Woolf's critical style. Distractors are well-designed and require reading the full text."
    },
    metadata: { created_at: "2026-06-23T20:12:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "approved"
  },
  {
    question_id: "sat-rw-ii-0003",
    exam_type: "SAT",
    section: "Reading and Writing",
    domain: "Information and Ideas",
    skill_tag: "Command of Evidence",
    difficulty: "Medium",
    passage_intro: "The following passage is adapted from a 2022 ecology study on wolf reintroduction in Yellowstone National Park.",
    passage: "An ecology study hypothesized that the introduction of wolves in Yellowstone National Park led to an increase in beaver populations by reducing elk grazing, thereby allowing willow trees (a primary food and building source for beavers) to regenerate. To test this, researchers monitored willow tree canopy height and beaver dam counts in areas with high wolf density and areas with low wolf density over ten years.",
    stimulus: "The table below presents data on willow tree canopy height and beaver dam counts across wolf density zones:\n- High-wolf areas: Willow canopy height = 2.4 meters; Beaver dams = 4.2 per stream km.\n- Low-wolf areas: Willow canopy height = 0.8 meters; Beaver dams = 0.5 per stream km.",
    question_text: "Which finding, if true, would most directly support the researchers' hypothesis?",
    answer_choices: [
      { id: "A", text: "In high-wolf areas, willow tree height and beaver dams increased significantly, while in low-wolf areas they remained low or declined." },
      { id: "B", text: "Beaver populations grew uniformly across both high and low wolf density zones due to a general reduction in regional rainfall." },
      { id: "C", text: "Elk populations in low-wolf areas showed a preference for feeding on plants other than willow trees." },
      { id: "D", text: "Beavers in low-wolf areas migrated to high-wolf areas because of artificial structures introduced by park rangers." }
    ],
    correct_answer: "A",
    explanation: {
      correct_rationale: "The hypothesis is that wolves trigger a trophic cascade (Wolves down -> Elk down -> Willow up -> Beaver up). Option A directly supports this cascade by showing that willow height and beaver dams rose specifically in high-wolf areas where elk grazing was reduced.",
      distractor_rationale: {
        "B": "Uniform growth across both areas would contradict the idea that wolf density was the driving factor.",
        "C": "If elk in low-wolf areas didn't eat willows, then willows would have grown there too, weakening the contrast.",
        "D": "Migration due to park rangers introduces a confounding variable, undermining the wolf hypothesis."
      }
    },
    similarity_score: 0.18,
    similar_question_id: null,
    generation_attempt: 1,
    validation: {
      validation_status: "PASS",
      accuracy_score: 93,
      checks: { correctness: "PASS", distractor_quality: "PASS", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "PASS", bias_sensitivity: "PASS" },
      feedback: "Nice ecological trophic cascade setup. Very clear support pattern."
    },
    metadata: { created_at: "2026-06-23T20:15:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "approved"
  },
  {
    question_id: "sat-rw-ii-0004",
    exam_type: "SAT",
    section: "Reading and Writing",
    domain: "Information and Ideas",
    skill_tag: "Inferences",
    difficulty: "Hard",
    passage_intro: "The following passage is adapted from an introductory monograph on market economics.",
    passage: "Economists argue that when a government subsidizes a product, it artificially lowers the cost for consumers, leading to an expansion in demand. However, if the supply of the product is highly inelastic—meaning that producers cannot easily increase output due to physical or regulatory constraints—the subsidy is unlikely to increase the overall quantity of the product consumed. Instead, the sudden influx of subsidized buyers competing for a fixed supply will ________",
    stimulus: null,
    question_text: "Which choice most logically completes the chain of reasoning?",
    answer_choices: [
      { id: "A", text: "cause producers to reduce their manufacturing capacity due to higher raw material costs." },
      { id: "B", text: "drive the pre-subsidy market price up, absorbing the financial benefit of the subsidy into higher producer margins." },
      { id: "C", text: "lead to a sudden, permanent decrease in the demand for alternative substitute goods." },
      { id: "D", text: "force the government to eliminate regulatory constraints to prevent a surplus of the product." }
    ],
    correct_answer: "B",
    explanation: {
      correct_rationale: "If demand expands but supply is fixed (highly inelastic), the increased competition among buyers will bid up the price. Since the price goes up, the benefit of the subsidy goes to the producers (higher margins) rather than making it cheaper for the consumer, logically completing the argument.",
      distractor_rationale: {
        "A": "There is no reason producers would reduce capacity; they are receiving higher bids and have a subsidy.",
        "C": "While substitutes might be affected, it is not the immediate direct effect of bidding up a fixed supply.",
        "D": "Government actions are speculative and do not complete the economic pricing logic."
      }
    },
    similarity_score: 0.31,
    similar_question_id: null,
    generation_attempt: 1,
    validation: {
      validation_status: "PASS",
      accuracy_score: 96,
      checks: { correctness: "PASS", distractor_quality: "PASS", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "PASS", bias_sensitivity: "PASS" },
      feedback: "Rigorous microeconomic reasoning."
    },
    metadata: { created_at: "2026-06-23T20:18:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "approved"
  },
  {
    question_id: "sat-rw-ei-0005",
    exam_type: "SAT",
    section: "Reading and Writing",
    domain: "Expression of Ideas",
    skill_tag: "Transitions",
    difficulty: "Easy",
    passage: "Biologists originally classified fungi as plants due to their stationary nature and cell-wall structure. ________, genetic analysis revealed that fungi are closer relatives of animals than of plants, leading to the creation of a separate taxonomic kingdom.",
    stimulus: null,
    question_text: "Which choice completes the text with the most logical transition?",
    answer_choices: [
      { id: "A", text: "Consequently" },
      { id: "B", text: "In addition" },
      { id: "C", text: "However" },
      { id: "D", text: "Furthermore" }
    ],
    correct_answer: "C",
    explanation: {
      correct_rationale: "The first sentence describes an old classification (fungi as plants). The second sentence describes a contradicting scientific finding (fungi are closer to animals). This is a contrast relationship, making 'However' the correct transition.",
      distractor_rationale: {
        "A": "'Consequently' suggests a cause-effect relationship, but the genetic discovery is not a direct result of the original classification.",
        "B": "'In addition' suggests adding a similar point, which ignores the direct contradiction.",
        "D": "'Furthermore' suggests building on a point, whereas this is a pivotal correction."
      }
    },
    similarity_score: 0.12,
    similar_question_id: null,
    generation_attempt: 1,
    validation: {
      validation_status: "PASS",
      accuracy_score: 99,
      checks: { correctness: "PASS", distractor_quality: "PASS", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "PASS", bias_sensitivity: "PASS" },
      feedback: "Straightforward transition question, perfect for Easy rating."
    },
    metadata: { created_at: "2026-06-23T20:20:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "approved"
  },
  {
    question_id: "sat-rw-ei-0006",
    exam_type: "SAT",
    section: "Reading and Writing",
    domain: "Expression of Ideas",
    skill_tag: "Rhetorical Synthesis",
    difficulty: "Medium",
    passage: "While researching a novel, a student takes the following notes:\n- The Maya civilization utilized a hieroglyphic writing system with over 800 symbols.\n- The system was logo-syllabic, combining logograms (representing words) and syllabograms (representing sounds).\n- It was written in double-column grids, read left-to-right, top-to-bottom.\n- Archaeologist Yuri Knorozov deciphered the phonetic aspects of the script in 1952.",
    stimulus: null,
    question_text: "The student wants to describe the composition and mechanics of the Maya hieroglyphic writing system. Which choice most effectively uses relevant information from the notes to accomplish this goal?",
    answer_choices: [
      { id: "A", text: "Deciphered in 1952 by Yuri Knorozov, the Maya hieroglyphic system contained over 800 characters and symbols." },
      { id: "B", text: "The Maya hieroglyphic writing system used over 800 logo-syllabic characters written in double-column grids that were read left-to-right and top-to-bottom." },
      { id: "C", text: "The logo-syllabic writing system combined word-based logograms with sound-based syllabograms, which made deciphering it extremely difficult." },
      { id: "D", text: "Yuri Knorozov discovered that the Maya script was written in grids and could be read Phonetically." }
    ],
    correct_answer: "B",
    explanation: {
      correct_rationale: "The prompt asks to describe BOTH the composition (over 800 logo-syllabic characters) AND the mechanics (double-column grids, read left-to-right, top-to-bottom). Option B combines these elements perfectly.",
      distractor_rationale: {
        "A": "This focuses on decipherment rather than mechanics of writing.",
        "C": "This introduces unstated opinions ('extremely difficult') and omits writing mechanics.",
        "D": "This credits Knorozov with discovering grids rather than phonetics, and omits composition details."
      }
    },
    similarity_score: 0.19,
    similar_question_id: null,
    generation_attempt: 1,
    validation: {
      validation_status: "PASS",
      accuracy_score: 94,
      checks: { correctness: "PASS", distractor_quality: "PASS", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "PASS", bias_sensitivity: "PASS" },
      feedback: "Accurately represents the Digital SAT rhetorical synthesis format."
    },
    metadata: { created_at: "2026-06-23T20:22:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "approved"
  },
  {
    question_id: "sat-rw-sec-0007",
    exam_type: "SAT",
    section: "Reading and Writing",
    domain: "Standard English Conventions",
    skill_tag: "Boundaries",
    difficulty: "Medium",
    passage: "In 1912, Alfred Wegener proposed that the Earth's continents were once joined in a single landmass called ________ Wegener called this theory continental drift, but it was widely rejected until plate tectonics was verified in the 1960s.",
    stimulus: null,
    question_text: "Which choice completes the text so that it conforms to the conventions of Standard English?",
    answer_choices: [
      { id: "A", text: "Pangaea," },
      { id: "B", text: "Pangaea;" },
      { id: "C", text: "Pangaea and" },
      { id: "D", text: "Pangaea" }
    ],
    correct_answer: "B",
    explanation: {
      correct_rationale: "The text contains two independent clauses. A semicolon (option B) is the correct punctuation to join two independent clauses without a coordinating conjunction.",
      distractor_rationale: {
        "A": "Using a comma alone results in a comma splice.",
        "C": "'Pangaea and Wegener...' leads to an awkward run-on sentence structure.",
        "D": "Lacking any punctuation results in a run-on sentence."
      }
    },
    similarity_score: 0.25,
    similar_question_id: null,
    generation_attempt: 1,
    validation: {
      validation_status: "PASS",
      accuracy_score: 97,
      checks: { correctness: "PASS", distractor_quality: "PASS", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "PASS", bias_sensitivity: "PASS" },
      feedback: "Classic semicolon boundaries check. No issues found."
    },
    metadata: { created_at: "2026-06-23T20:25:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "approved"
  },
  {
    question_id: "sat-m-alg-0008",
    exam_type: "SAT",
    section: "Math",
    domain: "Algebra",
    skill_tag: "Linear equations in one variable",
    difficulty: "Easy",
    passage: null,
    stimulus: "Equation: 4x - 7 = 3x + 9",
    question_text: "If 4x - 7 = 3x + 9, what is the value of x?",
    answer_choices: [
      { id: "A", text: "2" },
      { id: "B", text: "8" },
      { id: "C", text: "16" },
      { id: "D", text: "24" }
    ],
    correct_answer: "C",
    explanation: {
      correct_rationale: "To solve for x, subtract 3x from both sides: x - 7 = 9. Adding 7 to both sides gives x = 16.",
      distractor_rationale: {
        "A": "Result of dividing 16 by 8 by mistake.",
        "B": "Result of doing 9 - 7 instead of 9 + 7.",
        "D": "Result of adding 7 to 9 and getting 16, then adding another 8."
      }
    },
    similarity_score: 0.05,
    similar_question_id: null,
    generation_attempt: 1,
    validation: {
      validation_status: "PASS",
      accuracy_score: 100,
      checks: { correctness: "PASS", distractor_quality: "PASS", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "PASS", bias_sensitivity: "PASS" },
      feedback: "Simple, bullet-proof math question."
    },
    metadata: { created_at: "2026-06-23T20:30:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "approved"
  },
  {
    question_id: "sat-m-alg-0009",
    exam_type: "SAT",
    section: "Math",
    domain: "Algebra",
    skill_tag: "Systems of two linear equations",
    difficulty: "Medium",
    passage: null,
    stimulus: "System of equations:\n2x + 3y = 12\n5x - y = 13",
    question_text: "In the system of equations above, what is the value of x + y?",
    answer_choices: [
      { id: "A", text: "3" },
      { id: "B", text: "5" },
      { id: "C", text: "7" },
      { id: "D", text: "9" }
    ],
    correct_answer: "B",
    explanation: {
      correct_rationale: "Multiply the second equation by 3: 15x - 3y = 39. Add to first equation: 17x = 51, x = 3. Substitute: 5(3) - y = 13, y = 2. x + y = 5.",
      distractor_rationale: {
        "A": "Just the value of x.",
        "C": "Result of adding 5 + 2 by mistake.",
        "D": "Result of adding x = 3 and an incorrect y = 6."
      }
    },
    similarity_score: 0.14,
    similar_question_id: null,
    generation_attempt: 1,
    validation: {
      validation_status: "PASS",
      accuracy_score: 97,
      checks: { correctness: "PASS", distractor_quality: "PASS", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "PASS", bias_sensitivity: "PASS" },
      feedback: "Great two-equation system."
    },
    metadata: { created_at: "2026-06-23T20:32:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "approved"
  },
  {
    question_id: "sat-m-am-0010",
    exam_type: "SAT",
    section: "Math",
    domain: "Advanced Math",
    skill_tag: "Nonlinear functions",
    difficulty: "Hard",
    passage: null,
    stimulus: "Function: f(x) = (x - 3)^2 + 5",
    question_text: "The graph of the function f(x) above is a parabola in the xy-plane. If the graph is shifted 2 units to the right and 4 units down, which of the following equations represents the new graph g(x)?",
    answer_choices: [
      { id: "A", text: "g(x) = (x - 1)^2 + 1" },
      { id: "B", text: "g(x) = (x - 5)^2 + 1" },
      { id: "C", text: "g(x) = (x - 5)^2 + 9" },
      { id: "D", text: "g(x) = (x - 1)^2 + 9" }
    ],
    correct_answer: "B",
    explanation: {
      correct_rationale: "Original vertex is (3, 5). Shifting right 2: 3+2=5. Shifting down 4: 5-4=1. New vertex is (5,1), giving g(x) = (x-5)^2 + 1.",
      distractor_rationale: {
        "A": "Incorrectly subtracted 2 from h instead of adding.",
        "C": "Incorrectly added 4 to k instead of subtracting.",
        "D": "Incorrectly shifted left and up instead of right and down."
      }
    },
    similarity_score: 0.17,
    similar_question_id: null,
    generation_attempt: 1,
    validation: {
      validation_status: "PASS",
      accuracy_score: 96,
      checks: { correctness: "PASS", distractor_quality: "PASS", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "PASS", bias_sensitivity: "PASS" },
      feedback: "Accurate translation rules applied."
    },
    metadata: { created_at: "2026-06-23T20:35:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "approved"
  },
  {
    question_id: "sat-rw-cs-0011",
    exam_type: "SAT",
    section: "Reading and Writing",
    domain: "Craft and Structure",
    skill_tag: "Words in Context",
    difficulty: "Medium",
    passage: "Although the senator was known for her extremely verbose speeches, she gave a surprisingly ________ address at the ceremony, leaving the stage in under two minutes.",
    stimulus: null,
    question_text: "Which choice completes the text with the most logical and precise word or phrase?",
    answer_choices: [
      { id: "A", text: "laconic" },
      { id: "B", text: "brief" },
      { id: "C", text: "loquacious" },
      { id: "D", text: "articulate" }
    ],
    correct_answer: "A",
    explanation: {
      correct_rationale: "The passage sets up a contrast with 'extremely verbose.' 'Laconic' specifically targets word count and style, which contrasts verbosity.",
      distractor_rationale: {
        "A": "Laconic is the intended correct answer.",
        "B": "Brief is also extremely valid, which makes the question ambiguous.",
        "C": "Loquacious means talkative, which aligns with verbose.",
        "D": "Articulate means clear, which does not contrast with verbosity."
      }
    },
    similarity_score: 0.38,
    similar_question_id: null,
    generation_attempt: 2,
    validation: {
      validation_status: "FAIL",
      accuracy_score: 75,
      checks: { correctness: "FAIL", distractor_quality: "FAIL", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "PASS", bias_sensitivity: "PASS" },
      feedback: "Double correct answer detected: both 'laconic' and 'brief' are valid. Rewrite to replace 'brief' with 'tedious' or 'redundant'."
    },
    metadata: { created_at: "2026-06-23T20:40:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "escalated"
  },
  {
    question_id: "sat-m-gt-0012",
    exam_type: "SAT",
    section: "Math",
    domain: "Geometry and Trigonometry",
    skill_tag: "Area and volume",
    difficulty: "Medium",
    passage: null,
    stimulus: "A cylinder has a height of 8 inches and a radius of 3 inches. A cone has a height of 8 inches and a radius of 3 inches.",
    question_text: "What is the ratio of the volume of the cylinder to the volume of the cone?",
    answer_choices: [
      { id: "A", text: "1:3" },
      { id: "B", text: "1:1" },
      { id: "C", text: "3:1" },
      { id: "D", text: "9:1" }
    ],
    correct_answer: "C",
    explanation: {
      correct_rationale: "V_cyl = pi*r^2*h, V_cone = (1/3)*pi*r^2*h. Ratio = 1/(1/3) = 3:1.",
      distractor_rationale: {
        "A": "The ratio of cone to cylinder, which is the reciprocal.",
        "B": "Assumes volume formulas are identical.",
        "D": "Squaring the ratio of volumes by mistake."
      }
    },
    similarity_score: 0.11,
    similar_question_id: null,
    generation_attempt: 1,
    validation: {
      validation_status: "PASS",
      accuracy_score: 98,
      checks: { correctness: "PASS", distractor_quality: "PASS", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "PASS", bias_sensitivity: "PASS" },
      feedback: "Excellent geometry question."
    },
    metadata: { created_at: "2026-06-23T20:42:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "approved"
  },
  {
    question_id: "sat-m-ps-0013",
    exam_type: "SAT",
    section: "Math",
    domain: "Problem-Solving and Data Analysis",
    skill_tag: "Probability and conditional probability",
    difficulty: "Medium",
    passage: null,
    stimulus: "The table below shows the distribution of blood types and Rh factors for a group of 200 participants.\n\n| Blood Type | Rh+ | Rh- | Total |\n|---|---|---|---|\n| Type A | 72 | 12 | 84 |\n| Type B | 30 | 6 | 36 |\n| Type AB | 18 | 2 | 20 |\n| Type O | 50 | 10 | 60 |\n| Total | 170 | 30 | 200 |",
    question_text: "If a participant from this group who is Rh- is chosen at random, what is the probability that the participant has blood Type AB?",
    answer_choices: [
      { id: "A", text: "1/100" },
      { id: "B", text: "1/15" },
      { id: "C", text: "1/10" },
      { id: "D", text: "3/50" }
    ],
    correct_answer: "B",
    explanation: {
      correct_rationale: "Total Rh- = 30. Type AB and Rh- = 2. Probability = 2/30 = 1/15.",
      distractor_rationale: {
        "A": "2/200 = 1/100 — uses entire population instead of Rh- only.",
        "C": "2/20 = 1/10 — inverts the conditional.",
        "D": "Incorrect arithmetic."
      }
    },
    similarity_score: 0.16,
    similar_question_id: null,
    generation_attempt: 1,
    validation: {
      validation_status: "PASS",
      accuracy_score: 95,
      checks: { correctness: "PASS", distractor_quality: "PASS", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "PASS", bias_sensitivity: "PASS" },
      feedback: "Perfect conditional probability layout."
    },
    metadata: { created_at: "2026-06-23T20:45:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "approved"
  },
  {
    question_id: "sat-rw-ii-0014",
    exam_type: "SAT",
    section: "Reading and Writing",
    domain: "Information and Ideas",
    skill_tag: "Central Ideas and Details",
    difficulty: "Medium",
    passage: "Historically, oceanography focused primarily on mapping surface currents and coastal coastlines. However, in recent decades, the deployment of deep-sea pressure sensors and autonomous submersibles has shifted scientific focus to the abyssal plains—vast, dark, and flat regions that cover more than half of the Earth's surface. These deep-sea instruments have revealed that instead of being dormant and barren, the abyssal zones host complex ecosystems fueled by hydrothermal vents and play a critical role in global carbon sequestration, showing that the deepest oceans are far more dynamic than previously thought.",
    stimulus: null,
    question_text: "Which choice best summarizes the central idea of the passage?",
    answer_choices: [
      { id: "A", text: "Abyssal plains are flat regions covering most of the Earth's surface that have recently become accessible to mapping." },
      { id: "B", text: "New technology has revealed that abyssal zones are biochemically active and ecologically diverse, correcting a previous view of them as inert." },
      { id: "C", text: "Modern oceanography has ceased mapping surface currents to allocate all resources to studying carbon sequestration in deep-sea plains." },
      { id: "D", text: "Hydrothermal vents are the sole source of ecological complexity in the deep ocean and are currently under threat from environmental shifts." }
    ],
    correct_answer: "B",
    explanation: {
      correct_rationale: "New deep-sea instruments shifted scientists' understanding of abyssal plains from barren/dormant to complex ecosystems playing a key role in carbon sequestration. This matches option B.",
      distractor_rationale: {
        "A": "This is a secondary detail; mapping is not the central scientific insight.",
        "C": "The text never states they ceased surface mapping entirely.",
        "D": "Vents are mentioned, but 'sole source' and 'under threat' are unsupported."
      }
    },
    similarity_score: 0.13,
    similar_question_id: null,
    generation_attempt: 1,
    validation: {
      validation_status: "PASS",
      accuracy_score: 94,
      checks: { correctness: "PASS", distractor_quality: "PASS", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "PASS", bias_sensitivity: "PASS" },
      feedback: "Good scientific passage with a clear pivot."
    },
    metadata: { created_at: "2026-06-23T20:48:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "approved"
  },
  {
    question_id: "sat-m-alg-0015",
    exam_type: "SAT",
    section: "Math",
    domain: "Algebra",
    skill_tag: "Linear functions",
    difficulty: "Medium",
    passage: null,
    stimulus: "A plumbing service charges a flat fee of $50 for a service call plus an hourly rate of $35. The total cost, C, in dollars, for h hours of work can be represented by the linear function C(h) = 35h + 50.",
    question_text: "According to the function, what does the value 35 represent?",
    answer_choices: [
      { id: "A", text: "The hourly rate of the plumber." },
      { id: "B", text: "The flat fee for the service call." },
      { id: "C", text: "The maximum number of hours the plumber can work." },
      { id: "D", text: "The cost per minute of plumbing labor." }
    ],
    correct_answer: "A",
    explanation: {
      correct_rationale: "In C(h) = m*h + b, the slope 'm' represents the rate per unit of h. Since h is hours, 35 is the hourly rate.",
      distractor_rationale: {
        "B": "This is the y-intercept, which is 50.",
        "C": "No limit is mentioned in the formula.",
        "D": "Represented by 35/60, not 35."
      }
    },
    similarity_score: 0.89,
    similar_question_id: "sat-m-alg-0008",
    generation_attempt: 1,
    validation: {
      validation_status: "FAIL",
      accuracy_score: 82,
      checks: { correctness: "PASS", distractor_quality: "PASS", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "FAIL", bias_sensitivity: "PASS" },
      feedback: "Nearly identical to existing textbook corpus. Generate a completely new context."
    },
    metadata: { created_at: "2026-06-23T20:50:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "escalated"
  },
  {
    question_id: "sat-rw-sec-0016",
    exam_type: "SAT",
    section: "Reading and Writing",
    domain: "Standard English Conventions",
    skill_tag: "Boundaries",
    difficulty: "Medium",
    passage: "During her expedition in Kenya, zoologist Cynthia Moss observed that older female elephants often act as matriarchs ________ they lead their herds to scarce water sources and coordinate collective defenses against predators.",
    stimulus: null,
    question_text: "Which choice completes the text so that it conforms to the conventions of Standard English?",
    answer_choices: [
      { id: "A", text: "matriarchs, and" },
      { id: "B", text: "matriarchs; because" },
      { id: "C", text: "matriarchs, in addition," },
      { id: "D", text: "matriarchs:" }
    ],
    correct_answer: "D",
    explanation: {
      correct_rationale: "The second clause explains and elaborates on the first. A colon introduces a clause that amplifies the preceding one.",
      distractor_rationale: {
        "A": "'and' does not establish the explanatory relationship clearly.",
        "B": "Semicolon followed by 'because' makes the second clause subordinate.",
        "C": "Comma with 'in addition,' is a comma splice."
      }
    },
    similarity_score: 0.17,
    similar_question_id: null,
    generation_attempt: 1,
    validation: {
      validation_status: "PASS",
      accuracy_score: 95,
      checks: { correctness: "PASS", distractor_quality: "PASS", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "PASS", bias_sensitivity: "PASS" },
      feedback: "Excellent colon boundaries question."
    },
    metadata: { created_at: "2026-06-23T20:52:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "approved"
  },
  {
    question_id: "sat-m-gt-0017",
    exam_type: "SAT",
    section: "Math",
    domain: "Geometry and Trigonometry",
    skill_tag: "Circles",
    difficulty: "Hard",
    passage: null,
    stimulus: "Equation of a circle: x^2 + y^2 - 6x + 8y = 11",
    question_text: "In the xy-plane, the equation of a circle is given above. What is the radius of the circle?",
    answer_choices: [
      { id: "A", text: "sqrt(11)" },
      { id: "B", text: "5" },
      { id: "C", text: "6" },
      { id: "D", text: "36" }
    ],
    correct_answer: "C",
    explanation: {
      correct_rationale: "Complete the square: (x-3)^2 + (y+4)^2 = 11+9+16 = 36. So r = sqrt(36) = 6.",
      distractor_rationale: {
        "A": "Assumes 11 is r^2 without completing the square.",
        "B": "Incorrect completion of square giving r^2=25.",
        "D": "The value of r^2, forgetting to take the square root."
      }
    },
    similarity_score: 0.15,
    similar_question_id: null,
    generation_attempt: 1,
    validation: {
      validation_status: "PASS",
      accuracy_score: 98,
      checks: { correctness: "PASS", distractor_quality: "PASS", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "PASS", bias_sensitivity: "PASS" },
      feedback: "Complete-the-square circle equation. Well structured."
    },
    metadata: { created_at: "2026-06-23T20:55:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "approved"
  },
  {
    question_id: "sat-rw-cs-0018",
    exam_type: "SAT",
    section: "Reading and Writing",
    domain: "Craft and Structure",
    skill_tag: "Cross-Text Connections",
    difficulty: "Hard",
    passage: "Text 1: Many scientists believe that bioluminescence in deep-sea creatures evolved primarily as a defense mechanism to startle or blind predators, allowing the prey to escape in the cover of darkness.\n\nText 2: Marine biologist Dr. Clara Diaz argues that while predator deterrence plays a role, bioluminescence serves a far more active social function. Diaz's observations of abyssal shrimp and jellyfish show that specific light pulsing frequencies correlate directly with cooperative hunting formations and mate attraction, suggesting that communication was the primary driver of bioluminescent evolution.",
    stimulus: null,
    question_text: "Based on the passages, how would Dr. Clara Diaz (Text 2) most likely respond to the primary claim made in Text 1?",
    answer_choices: [
      { id: "A", text: "By agreeing that defense is the primary purpose of bioluminescence, but noting that deep-sea creatures use it differently than shallow-water ones." },
      { id: "B", text: "By suggesting that cooperative hunting is a secondary behavior that developed long after defense mechanisms had fully evolved." },
      { id: "C", text: "By contending that bioluminescence evolved mainly to support social interaction and signaling rather than purely defensive utility." },
      { id: "D", text: "By dismissing the defensive hypothesis entirely, arguing that deep-sea predators possess advanced visual filters that negate any startling effect." }
    ],
    correct_answer: "C",
    explanation: {
      correct_rationale: "Diaz argues communication was the primary driver, not defense. She would contend social/signaling was the main driver, matching option C.",
      distractor_rationale: {
        "A": "Diaz disagrees that defense is primary.",
        "B": "Diaz believes communication came first, not as a later secondary behavior.",
        "D": "Diaz concedes deterrence plays a role — she does not dismiss it entirely."
      }
    },
    similarity_score: 0.28,
    similar_question_id: null,
    generation_attempt: 1,
    validation: {
      validation_status: "PASS",
      accuracy_score: 96,
      checks: { correctness: "PASS", distractor_quality: "PASS", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "PASS", bias_sensitivity: "PASS" },
      feedback: "Excellent multi-text connection."
    },
    metadata: { created_at: "2026-06-23T20:58:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "approved"
  },
  {
    question_id: "sat-m-ps-0019",
    exam_type: "SAT",
    section: "Math",
    domain: "Problem-Solving and Data Analysis",
    skill_tag: "Ratios, rates, and proportional relationships",
    difficulty: "Easy",
    passage: null,
    stimulus: "A recipe requires 3 cups of flour for every 2 cups of sugar. A baker wants to make a larger batch using 15 cups of flour.",
    question_text: "How many cups of sugar will the baker need?",
    answer_choices: [
      { id: "A", text: "5" },
      { id: "B", text: "10" },
      { id: "C", text: "12" },
      { id: "D", text: "22.5" }
    ],
    correct_answer: "B",
    explanation: {
      correct_rationale: "3/2 = 15/x. Cross-multiply: 3x = 30, x = 10.",
      distractor_rationale: {
        "A": "15/3 = 5, neglecting to multiply by 2.",
        "C": "Subtracting 3 from 15 by mistake.",
        "D": "Multiplying 15 * 1.5 instead of dividing correctly."
      }
    },
    similarity_score: 0.08,
    similar_question_id: null,
    generation_attempt: 1,
    validation: {
      validation_status: "PASS",
      accuracy_score: 100,
      checks: { correctness: "PASS", distractor_quality: "PASS", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "PASS", bias_sensitivity: "PASS" },
      feedback: "Simple, precise, and unambiguous."
    },
    metadata: { created_at: "2026-06-23T21:00:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "approved"
  },
  {
    question_id: "sat-rw-ei-0020",
    exam_type: "SAT",
    section: "Reading and Writing",
    domain: "Expression of Ideas",
    skill_tag: "Rhetorical Synthesis",
    difficulty: "Hard",
    passage: "While researching a bioluminescent organism, a student takes the following notes:\n- The railroad worm (Phrixothrix hirtus) is a beetle larva.\n- It is unique because it can emit two different colors of light: red and greenish-yellow.\n- It possesses two types of light organs: a pair of red lanterns on its head, and eleven pairs of greenish-yellow lanterns on its abdomen.\n- The red head lanterns are used as headlights to navigate in the dark and spot prey.\n- The abdominal greenish-yellow lanterns serve as a warning to deter predators.",
    stimulus: null,
    question_text: "The student wants to contrast the location and function of the railroad worm's two types of light organs. Which choice most effectively uses relevant information from the notes to accomplish this goal?",
    answer_choices: [
      { id: "A", text: "The Phrixothrix hirtus beetle larva, commonly called the railroad worm, has abdominal organs emitting warning green lights, and head organs emitting red light." },
      { id: "B", text: "The railroad worm is unique because it features a pair of red organs on its head that act as navigating headlights, in contrast to its eleven pairs of abdominal greenish-yellow organs that serve to warn and deter predators." },
      { id: "C", text: "With eleven abdominal lanterns and a pair of red head lanterns, the railroad worm can illuminate its path and deter predators simultaneously." },
      { id: "D", text: "To navigate and scare off predators, the railroad worm utilizes abdominal green lights and red head lanterns." }
    ],
    correct_answer: "B",
    explanation: {
      correct_rationale: "Option B is the only choice that fully details both locations and both functions while using a clear contrast transition ('in contrast to').",
      distractor_rationale: {
        "A": "Mentions locations and colors, but omits functions entirely.",
        "C": "Mentions locations and functions but does not clearly contrast them.",
        "D": "Omits quantity details and lacks a clear contrasting structure."
      }
    },
    similarity_score: 0.23,
    similar_question_id: null,
    generation_attempt: 1,
    validation: {
      validation_status: "PASS",
      accuracy_score: 96,
      checks: { correctness: "PASS", distractor_quality: "PASS", clarity: "PASS", difficulty_alignment: "PASS", domain_skill_alignment: "PASS", originality: "PASS", bias_sensitivity: "PASS" },
      feedback: "Perfect rhetorical synthesis question."
    },
    metadata: { created_at: "2026-06-23T21:05:00Z", model_version: "gemini-3.5-flash", config_version: "sat.json-v1", exam_specific: {} },
    status: "approved"
  }
];