(function (root) {
    'use strict';

    var Model = root.SkillForgerModel;
    var Engine = root.SkillForgerEngine;
    var PATTERNS = [
        ['regen', 'Recuperar recurso'],
        ['regen_turn', 'Regenerar por turno'],
        ['regen_max', 'Regenerar % por turno'],
        ['buff', 'Buff'],
        ['debuff', 'Debuff'],
        ['damage', 'Dano'],
        ['drain', 'Drenar recurso'],
        ['transfer', 'Transferir recurso'],
        ['cleanse', 'Purificar'],
        ['dispel', 'Dissipar'],
        ['cleanse_turn', 'Purificação contínua'],
        ['heal_max', 'Cura % vida máxima'],
        ['regen_max_once', 'Restaurar % do máximo'],
        ['random_regen', 'Recurso aleatório'],
        ['spend_trigger', 'Punir gasto de recurso'],
        ['modulate', 'Modulação elemental'],
        ['shield_effect', 'Escudo'],
        ['charges', 'Cargas'],
        ['upgrade_status', 'Reforço condicional'],
        ['trip', 'Armadilha'],
        ['deferred', 'Dano atrasado'],
        ['echo', 'Repetir ação'],
        ['move', 'Mover posição'],
        ['stall', 'Atrasar turno'],
        ['react_move', 'Mover ao ser falhado'],
        ['weather', 'Instalar clima'],
        ['sight', 'Mira de projéteis'],
        ['mark', 'Marcar para projéteis'],
        ['veil', 'Véu anti-atiradores'],
        ['reroll', 'Segunda chance no ar'],
        ['upkeep', 'Manter carga'],
        ['rewind', 'Retroceder tempo'],
        ['detonate', 'Detonar no turno'],
        ['chain_detonation', 'Marca em cadeia'],
        ['conductor', 'Condutor elétrico'],
        ['interrupt', 'Interromper ação'],
        ['reflect', 'Refletir dano fixo'],
        ['spend_steal', 'Roubar gasto de recurso'],
        ['evade_next', 'Esquiva e riposta'],
        ['damage_redirect', 'Redirecionar dano'],
        ['cost_multiplier', 'Desconto de custo'],
        ['end_cost', 'Custo ao terminar'],
        ['on_death_blast', 'Explosão ao cair'],
        ['stack_dot', 'Stack com dano (Burn/Fuel)'],
        ['burst_stacks', 'Stack com explosão (Overheat)'],
        ['fire_wall', 'Muro de fogo'],
        ['element_damage', 'Dano elemental'],
        ['projectile_element', 'Projétil como elemento'],
        ['ignite_attacker', 'Queimar atacante'],
        ['turn_end_burn', 'Queimar no fim do turno'],
        ['cleanse_dot', 'Limpar dano contínuo'],
        ['regen_bonus', 'Bónus de regeneração'],
        ['regen_lowest', 'Restaurar recurso mais baixo'],
        ['refund_spent', 'Devolver recurso gasto'],
        ['cleanse_on_heal', 'Limpar ao receber cura'],
        ['damage_reduction', 'Redução de dano'],
        ['drain_max', 'Drenar % do máximo'],
        ['drain_turn', 'Drenar % por turno'],
        ['movement_immune', 'Imune a movimento'],
        ['stat_multipliers', 'Multiplicadores de atributos'],
    ];
    var TARGET_LABELS = {
        any_one: 'qualquer personagem', enemies_all: 'todos os inimigos',
        enemies_lane: 'os inimigos da lane do alvo',
        allies_all: 'todos os aliados',
        self: 'o próprio atacante', both_teams: 'ambas as equipas',
    };
    var ZOOM_MIN = 0.1;
    var ZOOM_MAX = 2;
    var ZOOM_STEP = 0.1;
    var DEFAULT_SIMULATOR = {
        skillId: null,
        attackerPhysicalAttack: 30,
        attackerMagicalAttack: 30,
        attackerSpeed: 16,
        attackerAccuracyStat: 0,
        attackerCritStat: 0,
        attackerLine: 'front',
        defenderPhysicalDefense: 20,
        defenderMagicalDefense: 20,
        defenderEvasion: 0,
        defenderLine: 'front',
        defenderDefending: false,
        defenderElements: [],
        defenderStatuses: [],
        targetHpPercent: 100,
        phase: 'day',
        level: 1,
    };
    var state = {
        project: Model.load(),
        view: 'skills',
        selectedSkillId: null,
        search: '',
        elementFilter: 'all',
        treeElement: 'aqua',
        zoom: 1,
        treeLayout: null,
        prerequisiteSelection: new Set(),
        prerequisiteSearch: '',
        openScopes: Object.create(null),
        autoDescription: Object.create(null),
        pan: null,
        saveTimer: null,
        toastTimer: null,
        simulator: Object.assign({}, DEFAULT_SIMULATOR, { defenderElements: [] }),
    };

    function byId(id) { return document.getElementById(id); }
    function currentSkill() { return state.project.skills.find(function (skill) { return skill.id === state.selectedSkillId; }) || null; }
    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, function (character) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
        });
    }
    function sortedSkills(skills) {
        return skills.slice().sort(function (a, b) {
            return a.element_id.localeCompare(b.element_id) || a.id.localeCompare(b.id);
        });
    }
    function optionMarkup(value, label, selected) {
        return '<option value="' + escapeHtml(value) + '"' + (selected ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }

    function boot() {
        state.selectedSkillId = state.project.skills[0]?.id || null;
        // Uma descrição vinda do rascunho é do autor: nunca a reescrevemos.
        state.project.skills.forEach(function (skill) { state.autoDescription[skill.id] = false; });
        Model.ensurePositions(state.project);
        populateElementSelects();
        populateTemplateSelect();
        wireEvents();
        renderAll();
        if (!root.jsyaml) toast('YAML offline: JSON válido como YAML 1.2 será usado nos ficheiros exportados.', true);
    }

    function populateElementSelects() {
        var elements = Model.ELEMENTS.map(function (id) { return optionMarkup(id, id, false); }).join('');
        byId('element-filter').innerHTML = optionMarkup('all', 'Todos', true) + elements;
        document.querySelector('[name="element_id"]').innerHTML = elements;
        byId('tree-element').innerHTML = elements;
        byId('element-filter').value = state.elementFilter;
        byId('tree-element').value = state.treeElement;
        var quick = byId('quick-element');
        quick.innerHTML = elements;
        quick.value = defaultElement();
    }

    function populateTemplateSelect() {
        var grouped = new Map();
        Model.TEMPLATES.forEach(function (template) {
            var category = grouped.get(template.category) || [];
            category.push(template);
            grouped.set(template.category, category);
        });
        byId('create-template').innerHTML = '<option value="">Blank — skill vazia</option>'
            + Array.from(grouped.entries()).map(function (entry) {
                return '<optgroup label="' + escapeHtml(entry[0]) + '">' + entry[1].map(function (template) {
                    return optionMarkup(template.id, template.title, false);
                }).join('') + '</optgroup>';
            }).join('');
    }

    function wireEvents() {
        document.querySelectorAll('.view-tab').forEach(function (button) {
            button.addEventListener('click', function () { setView(button.dataset.view); });
        });
        byId('btn-new-skill').addEventListener('click', function () {
            var templateId = byId('create-template').value;
            var template = Model.TEMPLATES.find(function (item) { return item.id === templateId; }) || null;
            createSkill([], defaultElement(), template);
        });
        byId('btn-empty-new').addEventListener('click', function () { createSkill([], defaultElement()); });
        byId('quick-create').addEventListener('submit', function (event) {
            event.preventDefault();
            var name = byId('quick-name').value.trim();
            if (!name) { byId('quick-name').focus(); return; }
            createSkill([], byId('quick-element').value, null, name);
        });
        byId('btn-describe-skill').addEventListener('click', function () {
            var skill = currentSkill();
            if (!skill) return;
            syncSkillFromEditor(skill);
            var description = Model.describeSkill(skill);
            byId('skill-editor').elements.description.value = description;
            skill.description = description;
            persist();
            renderInspector();
            updateDescriptionCounter();
        });
        byId('btn-add-bonus-vs').addEventListener('click', function () {
            var skill = currentSkill();
            if (!skill) return;
            addBonusRow(skill);
        });
        byId('btn-simulate-skill').addEventListener('click', function () {
            var skill = currentSkill();
            if (skill) state.simulator.skillId = skill.id;
            setView('simulator');
        });
        byId('btn-sim-reset').addEventListener('click', function () {
            state.simulator = Object.assign({}, DEFAULT_SIMULATOR, {
                skillId: state.simulator.skillId,
                defenderElements: [],
            });
            syncSimulatorInputs();
            renderSimulator();
        });
        byId('btn-tree-first-skill').addEventListener('click', function () { createSkill([], state.treeElement); });
        byId('btn-duplicate-skill').addEventListener('click', duplicateSelectedSkill);
        byId('btn-delete-skill').addEventListener('click', deleteSelectedSkill);
        byId('btn-import').addEventListener('click', function () { byId('file-input').click(); });
        byId('file-input').addEventListener('change', importFiles);
        byId('btn-export').addEventListener('click', exportPackage);
        byId('btn-import-error-ok').addEventListener('click', closeImportError);
        byId('import-error-backdrop').addEventListener('click', function (event) {
            if (event.target === byId('import-error-backdrop')) closeImportError();
        });
        byId('skill-search').addEventListener('input', function (event) {
            state.search = event.target.value.trim().toLowerCase();
            renderSkillList();
        });
        byId('element-filter').addEventListener('change', function (event) {
            state.elementFilter = event.target.value;
            renderSkillList();
        });
        byId('prerequisite-search').addEventListener('input', function (event) {
            state.prerequisiteSearch = event.target.value.trim().toLowerCase();
            var skill = currentSkill();
            if (skill) renderPrerequisites(skill);
        });
        byId('prerequisite-selected').addEventListener('click', removePrerequisite);
        byId('validation-list').addEventListener('click', handleValidationClick);

        byId('skill-editor').addEventListener('input', handleEditorInput);
        byId('skill-editor').addEventListener('change', handleEditorChange);
        byId('prerequisite-list').addEventListener('change', handlePrerequisiteChange);
        byId('skill-editor').addEventListener('change', handleScopeToggle);
        byId('skill-editor').addEventListener('change', handleCollateralToggle);
        byId('skill-editor').addEventListener('click', handleEffectActions);
        byId('skill-editor').addEventListener('input', handleEffectInput);
        byId('skill-editor').addEventListener('change', handleEffectChange);

        byId('tree-element').addEventListener('change', function (event) {
            state.treeElement = event.target.value;
            renderTree();
        });
        byId('tree-nodes').addEventListener('click', function (event) {
            var node = event.target.closest('[data-skill-node]');
            if (!node) return;
            state.selectedSkillId = node.dataset.skillNode;
            byId('tree-nodes').querySelectorAll('[data-skill-node]').forEach(function (card) {
                card.classList.toggle('is-focused', card.dataset.skillNode === state.selectedSkillId);
            });
            var skills = state.project.skills.filter(function (skill) { return skill.element_id === state.treeElement; });
            renderEdges(skills, Model.layout(state.project, state.treeElement));
        });
        byId('tree-nodes').addEventListener('dblclick', function (event) {
            var node = event.target.closest('[data-skill-node]');
            if (!node) return;
            state.selectedSkillId = node.dataset.skillNode;
            setView('skills');
            renderSkillList();
            renderEditor();
            renderInspector();
        });
        byId('tree-canvas').addEventListener('pointerdown', startPan);
        window.addEventListener('pointermove', movePan);
        window.addEventListener('pointerup', stopPan);
        byId('btn-zoom-in').addEventListener('click', function () { setZoom(state.zoom + ZOOM_STEP); });
        byId('btn-zoom-out').addEventListener('click', function () { setZoom(state.zoom - ZOOM_STEP); });
        byId('btn-zoom-reset').addEventListener('click', fitTree);
        byId('zoom-level').addEventListener('click', function () { setZoom(1); });
        byId('tree-canvas').addEventListener('wheel', function (event) {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            setZoom(state.zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP), event);
        }, { passive: false });

        byId('sim-skill').addEventListener('change', function (event) {
            state.simulator.skillId = event.target.value;
            renderSimulator();
        });
        var SIM_NUMBER_FIELDS = {
            'sim-attack-physical': 'attackerPhysicalAttack',
            'sim-attack-magical': 'attackerMagicalAttack',
            'sim-attacker-speed': 'attackerSpeed',
            'sim-attacker-accuracy': 'attackerAccuracyStat',
            'sim-attacker-crit': 'attackerCritStat',
            'sim-defense-physical': 'defenderPhysicalDefense',
            'sim-defense-magical': 'defenderMagicalDefense',
            'sim-defender-evasion': 'defenderEvasion',
            'sim-target-hp': 'targetHpPercent',
        };
        Object.keys(SIM_NUMBER_FIELDS).forEach(function (id) {
            byId(id).addEventListener('input', function (event) {
                state.simulator[SIM_NUMBER_FIELDS[id]] = numberValue(event.target.value, 0);
                renderSimulator();
            });
        });
        byId('sim-defender-statuses').addEventListener('input', function (event) {
            var labels = String(event.target.value || '').split(',').map(function (entry) { return entry.trim(); }).filter(Boolean);
            state.simulator.defenderStatuses = labels;
            renderSimulator();
        });
        var SIM_SELECT_FIELDS = {
            'sim-attacker-line': 'attackerLine',
            'sim-defender-line': 'defenderLine',
            'sim-phase': 'phase',
        };
        Object.keys(SIM_SELECT_FIELDS).forEach(function (id) {
            byId(id).addEventListener('change', function (event) {
                state.simulator[SIM_SELECT_FIELDS[id]] = event.target.value;
                renderSimulator();
            });
        });
        byId('sim-level').addEventListener('change', function (event) {
            state.simulator.level = numberValue(event.target.value, 1);
            renderSimulator();
        });
        byId('sim-defending').addEventListener('change', function (event) {
            state.simulator.defenderDefending = event.target.checked;
            renderSimulator();
        });
        byId('sim-elements').addEventListener('change', function (event) {
            var elementId = event.target.dataset.element;
            if (!elementId) return;
            var selected = new Set(state.simulator.defenderElements);
            if (event.target.checked) selected.add(elementId);
            else selected.delete(elementId);
            state.simulator.defenderElements = Array.from(selected);
            renderSimulator();
        });
    }

    function setView(view) {
        state.view = view;
        document.querySelectorAll('.view-tab').forEach(function (button) {
            button.classList.toggle('is-active', button.dataset.view === view);
        });
        byId('skills-view').hidden = view !== 'skills';
        byId('trees-view').hidden = view !== 'trees';
        byId('simulator-view').hidden = view !== 'simulator';
        if (view === 'trees') renderTree();
        if (view === 'simulator') { syncSimulatorInputs(); renderSimulator(); }
    }

    function renderAll() {
        byId('skill-count').textContent = state.project.skills.length;
        byId('tree-count').textContent = new Set(state.project.skills.map(function (skill) { return skill.element_id; })).size;
        renderSkillList();
        renderEditor();
        renderInspector();
        renderTree();
        renderSimulator();
    }

    function renderSkillList() {
        var list = byId('skill-list');
        var skills = sortedSkills(state.project.skills).filter(function (skill) {
            var searchMatch = !state.search || (skill.name + ' ' + skill.id + ' ' + skill.element_id).toLowerCase().includes(state.search);
            return searchMatch && (state.elementFilter === 'all' || skill.element_id === state.elementFilter);
        });
        byId('visible-count').textContent = skills.length;
        list.innerHTML = skills.length ? skills.map(function (skill) {
            return '<button type="button" class="skill-row ' + (skill.id === state.selectedSkillId ? 'is-selected' : '') + '" data-skill-id="' + escapeHtml(skill.id) + '">'
                + '<span class="skill-row-text"><strong>' + escapeHtml(skill.name) + '</strong><small>' + escapeHtml(skill.element_id) + ' <i>·</i> ' + escapeHtml(skill.id) + '</small></span></button>';
        }).join('') : '<div class="list-empty">' + (state.project.skills.length ? 'Sem resultados para esta pesquisa.' : 'Ainda não há skills. Cria uma ou começa por um modelo.') + '</div>';
        list.querySelectorAll('[data-skill-id]').forEach(function (button) {
            button.addEventListener('click', function () {
                state.selectedSkillId = button.dataset.skillId;
                state.prerequisiteSearch = '';
                byId('prerequisite-search').value = '';
                renderSkillList();
                renderEditor();
                renderInspector();
            });
        });
    }

    function renderEditor() {
        var skill = currentSkill();
        byId('empty-editor').hidden = Boolean(skill);
        byId('skill-editor').hidden = !skill;
        byId('btn-delete-skill').disabled = !skill;
        byId('btn-duplicate-skill').disabled = !skill;
        byId('current-id').textContent = skill ? skill.id : '—';
        if (!skill) {
            byId('prerequisite-list').innerHTML = '';
            byId('prerequisite-selected').innerHTML = '';
            byId('prerequisite-search').value = '';
            byId('self-effects').innerHTML = '';
            byId('target-effects').innerHTML = '';
            byId('team-effects').innerHTML = '';
            byId('bonus-vs-rows').innerHTML = '';
            byId('skill-summary').innerHTML = '';
            byId('editor-message').textContent = '';
            return;
        }

        state.prerequisiteSelection = new Set(skill.learning_requirements?.required_attack_ids || []);
        byId('prerequisite-search').value = state.prerequisiteSearch;

        var form = byId('skill-editor');
        form.elements.name.value = skill.name || '';
        form.elements.element_id.value = skill.element_id;
        form.elements.description.value = skill.description || '';
        form.elements.xp_cost.value = skill.learning_cost?.experience_points ?? 0;
        form.elements.targeting.value = normalizeTarget(skill.targeting);
        form.elements.direct_action.value = skill.damage ? 'damage' : 'none';
        form.elements.damage_type.value = skill.damage?.kind || skill.damage?.damage_type || 'magical';
        var power = skill.damage?.power;
        if (typeof power === 'number') power = { kind: 'fixed', value: power };
        form.elements.power_kind.value = skill.power_scaling?.stat ? 'attribute'
            : power?.kind === 'random' ? 'random' : 'fixed';
        form.elements.power_value.value = skill.power_scaling?.stat
            ? skill.power_scaling.per_point
            : (power?.value ?? power?.multiplier ?? power?.min ?? 0);
        form.elements.accuracy.value = Number(skill.accuracy ?? 100);
        form.elements.hit_count.value = skill.hit_count ?? 1;
        form.elements.mana_cost.value = skill.costs?.mana ?? 0;
        form.elements.stamina_cost.value = skill.costs?.stamina ?? 0;
        form.elements.hp_cost.value = skill.costs?.hp ?? 0;
        form.elements.cooldown.value = skill.costs?.cooldown ?? 0;
        form.elements.solar.checked = Boolean(skill.solar);
        form.elements.lunar.checked = Boolean(skill.lunar);
        form.elements.only_during_day.checked = Boolean(skill.only_during_day);
        form.elements.only_during_night.checked = Boolean(skill.only_during_night);
        form.elements.ignore_accuracy.checked = Boolean(skill.ignore_accuracy);
        form.elements.crit_chance.value = skill.crit_chance ?? '';
        if (form.elements.crit_multiplier) form.elements.crit_multiplier.value = skill.crit_multiplier ?? '';
        form.elements.guaranteed_crit_vs_status.value = skill.guaranteed_crit_vs_status || '';
        form.elements.defense_pierce.value = skill.defense_pierce ?? '';
        form.elements.bonus_vs_hp_below_threshold.value = skill.bonus_vs_hp_below?.threshold ?? '';
        form.elements.bonus_vs_hp_below_multiplier.value = skill.bonus_vs_hp_below?.multiplier ?? '';
        form.elements.flee_below_hp.value = skill.flee_below_hp ?? '';
        var bonusVsStatus = Array.isArray(skill.bonus_vs_status) ? skill.bonus_vs_status[0] : skill.bonus_vs_status;
        form.elements.bonus_vs_status_status.value = bonusVsStatus?.status || '';
        form.elements.bonus_vs_status_multiplier.value = bonusVsStatus?.multiplier ?? '';
        form.elements.bonus_vs_status_pierce.value = bonusVsStatus?.defense_pierce ?? '';
        form.elements.bonus_per_charge_status.value = skill.bonus_per_charge?.status || '';
        form.elements.bonus_per_charge_multiplier.value = skill.bonus_per_charge?.multiplier_per_charge ?? '';
        form.elements.bonus_per_charge_consume.checked = Boolean(skill.bonus_per_charge?.consume);
        if (form.elements.recoil_hp) form.elements.recoil_hp.value = skill.recoil?.hp ?? '';
        if (form.elements.friendly_fire_damage) form.elements.friendly_fire_damage.value = skill.friendly_fire?.damage ?? '';
        if (form.elements.backlane_power) form.elements.backlane_power.value = skill.backlane_splash?.power ?? '';
        if (form.elements.backlane_percent) form.elements.backlane_percent.value = percentOf(skill.backlane_splash?.percent_of_damage);
        if (form.elements.backlane_chance) form.elements.backlane_chance.value = percentOf(skill.backlane_splash?.chance);
        if (form.elements.no_space_recoil_fraction) form.elements.no_space_recoil_fraction.value = skill.no_space_recoil?.fraction ?? '';
        if (form.elements.control_immune_damage) form.elements.control_immune_damage.value = skill.control_immune_damage ?? '';
        if (form.elements.on_kill_detonation_power) form.elements.on_kill_detonation_power.value = skill.on_kill_detonation?.power ?? '';
        if (form.elements.chain_jumps) form.elements.chain_jumps.value = skill.chain?.jumps ?? '';
        if (form.elements.chain_power_percent) form.elements.chain_power_percent.value = percentOf(skill.chain?.power_percent);
        if (form.elements.chain_chance) form.elements.chain_chance.value = percentOf(skill.chain?.chance ?? 1);
        if (form.elements.chain_branches) form.elements.chain_branches.value = skill.chain?.branches ?? '';
        if (form.elements.shrapnel_count) form.elements.shrapnel_count.value = skill.shrapnel?.count ?? '';
        if (form.elements.shrapnel_power) form.elements.shrapnel_power.value = skill.shrapnel?.power ?? '';
        if (form.elements.instability_self_damage) form.elements.instability_self_damage.value = skill.instability?.self_damage ?? '';
        if (form.elements.cooldown_reset_status) form.elements.cooldown_reset_status.value = skill.cooldown_reset?.status ?? '';
        if (form.elements.cooldown_reset_amount) form.elements.cooldown_reset_amount.value = skill.cooldown_reset?.amount ?? '';
        if (form.elements.damage_taken_scaling_per_point) form.elements.damage_taken_scaling_per_point.value = skill.damage_taken_scaling?.per_point ?? '';
        if (form.elements.element_effectiveness_weak) form.elements.element_effectiveness_weak.value = skill.element_effectiveness?.weak ?? '';
        if (form.elements.element_effectiveness_resist) form.elements.element_effectiveness_resist.value = skill.element_effectiveness?.resist ?? '';
        var consume = Array.isArray(skill.consume_stacks) ? skill.consume_stacks[0] : null;
        if (form.elements.consume_status) form.elements.consume_status.value = consume?.status ?? '';
        if (form.elements.consume_per_stack) form.elements.consume_per_stack.value = consume?.per_stack ?? '';
        if (form.elements.consume_heal_percent) form.elements.consume_heal_percent.value = consume?.heal_percent_per_stack ?? '';
        if (form.elements.consume_ignore_defense) form.elements.consume_ignore_defense.checked = Boolean(consume?.ignore_defense);
        updatePowerFields(false);
        if (form.elements.power_kind.value === 'random' && form.elements.power_max) form.elements.power_max.value = power?.max ?? form.elements.power_value.value;
        if (form.elements.power_kind.value === 'attribute' && form.elements.power_stat) form.elements.power_stat.value = skill.power_scaling?.stat || 'speed';
        renderPrerequisites(skill);
        updateTargetContext(skill);
        renderCollateral(skill);
        renderEffectScopes(skill);
        renderBonusVs(skill);
        renderSkillSummary(skill);
        updateDescriptionCounter();
        byId('direct-cost').textContent = (Number(skill.learning_cost?.experience_points) || 0) + ' XP';
        byId('editor-message').textContent = 'O ID foi gerado uma vez. Alterar o nome não o altera.';
    }

    function updateDescriptionCounter() {
        var field = byId('skill-editor').elements.description;
        var counter = byId('description-counter');
        if (!field || !counter) return;
        var length = field.value.trim().length;
        counter.textContent = length ? length + ' caracteres' : 'Sem descrição — usa “Gerar descrição”.';
    }

    /**
     * Mantém a descrição em dia enquanto o autor não a tiver escrito.
     *
     * A partir do momento em que o texto é digitado, a descrição passa a ser do
     * autor e o Forger nunca mais a toca.
     */
    function refreshAutoDescription(skill) {
        if (!skill || state.autoDescription[skill.id] === false) return;
        var generated = Model.describeSkill(skill);
        if (generated === skill.description) return;
        skill.description = generated;
        var field = byId('skill-editor').elements.description;
        if (field && field.value !== generated) {
            field.value = generated;
            updateDescriptionCounter();
        }
    }

    /** Resumo em tiras: o que a skill é, num relance. */
    function renderSkillSummary(skill) {
        var container = byId('skill-summary');
        if (!container) return;
        var chips = [];
        chips.push({ label: 'Elemento', value: skill.element_id });
        chips.push({ label: 'Alvo', value: TARGET_LABELS[normalizeTarget(skill.targeting)] || skill.targeting });
        if (skill.damage) {
            var power = Model.readPowerValue(skill.damage.power);
            chips.push({
                label: 'Dano',
                value: power + ' ' + (skill.damage.kind === 'physical' ? 'físico' : 'mágico')
                    + (skill.hit_count > 1 ? ' × ' + skill.hit_count : ''),
            });
            chips.push({ label: 'Precisão', value: (skill.accuracy ?? 100) + '%' });
        } else {
            chips.push({ label: 'Dano', value: 'Sem dano direto' });
        }
        var costs = [];
        if (skill.costs?.mana) costs.push(skill.costs.mana + ' MP');
        if (skill.costs?.stamina) costs.push(skill.costs.stamina + ' ST');
        if (skill.costs?.cooldown) costs.push(skill.costs.cooldown + ' turnos');
        chips.push({ label: 'Custo', value: costs.length ? costs.join(' · ') : 'Grátis' });
        chips.push({ label: 'Aprender', value: (Number(skill.learning_cost?.experience_points) || 0) + ' XP' });
        if (skill.solar) chips.push({ label: 'Traço', value: 'Solar (×1.5 dia / ×0.5 noite)' });
        if (skill.lunar) chips.push({ label: 'Traço', value: 'Noturna (×1.5 noite / ×0.5 dia)' });
        if (skill.only_during_day) chips.push({ label: 'Restrição', value: 'Só de dia' });
        if (skill.only_during_night) chips.push({ label: 'Restrição', value: 'Só de noite' });
        if (skill.crit_chance) chips.push({ label: 'Crítico', value: skill.crit_chance + '%' });
        if (skill.crit_multiplier) chips.push({ label: 'Crítico', value: '×' + skill.crit_multiplier });
        if (skill.ignore_accuracy) chips.push({ label: 'Traço', value: 'Não falha' });
        if (skill.defense_pierce) chips.push({ label: 'Traço', value: 'Ignora ' + Math.round(skill.defense_pierce * 100) + '% da defesa' });
        if (skill.bonus_vs_elements && Object.keys(skill.bonus_vs_elements).length) {
            chips.push({
                label: 'Bónus',
                value: Object.keys(skill.bonus_vs_elements).map(function (id) { return id + ' ×' + skill.bonus_vs_elements[id]; }).join(' · '),
            });
        }
        var effectCount = (skill.effects || []).length;
        if (effectCount) chips.push({ label: 'Efeitos', value: String(effectCount) });
        container.innerHTML = chips.map(function (chip) {
            return '<span class="summary-chip"><span>' + escapeHtml(chip.label) + '</span><strong>' + escapeHtml(chip.value) + '</strong></span>';
        }).join('');
    }

    function normalizeTarget(value) {
        if (typeof value === 'string') return value;
        if (value && typeof value === 'object') return value.area || value.target || 'any_one';
        return 'any_one';
    }

    function renderPrerequisites(skill) {
        var selected = state.prerequisiteSelection;
        var query = state.prerequisiteSearch;
        var candidates = sortedSkills(state.project.skills.filter(function (candidate) {
            if (candidate.id === skill.id) return false;
            return !query || (candidate.id + ' ' + candidate.name + ' ' + candidate.element_id).toLowerCase().includes(query);
        }));
        byId('prerequisite-count').textContent = selected.size ? selected.size + ' selecionada(s)' : 'Nenhuma selecionada';
        byId('prerequisite-selected').innerHTML = selected.size
            ? Array.from(selected).map(function (id) {
                var candidate = state.project.skills.find(function (item) { return item.id === id; });
                var isExternal = Boolean(candidate) && candidate.element_id !== skill.element_id;
                var label = isExternal ? candidate.element_id + ' · ' + candidate.id : (candidate ? candidate.id : id);
                return '<span class="selected-requirement"' + (isExternal ? ' title="Pré-requisito externo (outra árvore)"' : '') + '>' + escapeHtml(label) + '<button type="button" data-remove-prerequisite="' + escapeHtml(id) + '" aria-label="Remover pré-requisito">×</button></span>';
            }).join('')
            : '';
        byId('prerequisite-list').innerHTML = candidates.length ? candidates.map(function (candidate) {
            var crossTree = candidate.element_id !== skill.element_id;
            return '<label class="prereq-option' + (selected.has(candidate.id) ? ' is-selected' : '') + '"><input type="checkbox" data-prerequisite="' + escapeHtml(candidate.id) + '" ' + (selected.has(candidate.id) ? 'checked' : '') + '><span class="prereq-copy"><strong>' + escapeHtml(candidate.name) + '</strong><small>' + escapeHtml(candidate.id) + '</small></span><span class="prereq-meta"><code>' + escapeHtml(candidate.element_id) + '</code><span>' + (crossTree ? 'OUTRA ÁRVORE' : 'ESTA ÁRVORE') + '</span><b>' + (Number(candidate.learning_cost?.experience_points) || 0) + ' XP</b></span></label>';
        }).join('') : '<p class="muted-label prereq-empty">' + (state.project.skills.length > 1 ? 'Nenhuma skill corresponde à pesquisa.' : 'Cria mais skills para escolher pré-requisitos.') + '</p>';
    }

    /* --- Bónus contra elementos ----------------------------------------- */
    function renderBonusVs(skill) {
        var container = byId('bonus-vs-rows');
        if (!container) return;
        var bonus = skill.bonus_vs_elements || {};
        container.innerHTML = Object.keys(bonus).map(function (elementId) {
            return bonusRowMarkup(elementId, bonus[elementId]);
        }).join('');
    }

    function bonusRowMarkup(elementId, multiplier) {
        var options = Model.ELEMENTS.map(function (id) {
            return optionMarkup(id, id, id === elementId);
        }).join('');
        return '<div class="bonus-row">'
            + '<select class="control control-small" data-bonus-element>' + options + '</select>'
            + '<div class="input-suffix bonus-value"><input class="control control-small" data-bonus-value type="number" min="0" step="0.1" value="' + escapeHtml(multiplier) + '"><span>×</span></div>'
            + '<button class="icon-button icon-button-small" type="button" data-remove-bonus title="Remover bónus">×</button>'
            + '</div>';
    }

    function addBonusRow(skill) {
        var container = byId('bonus-vs-rows');
        var used = new Set(Object.keys(skill.bonus_vs_elements || {}));
        var candidate = Model.ELEMENTS.find(function (id) { return !used.has(id); }) || Model.ELEMENTS[0];
        var wrapper = document.createElement('div');
        wrapper.innerHTML = bonusRowMarkup(candidate, 1.5);
        container.appendChild(wrapper.firstElementChild);
        syncBonusVs(skill);
        persist();
        renderInspector();
        renderSkillSummary(skill);
    }

    function syncBonusVs(skill) {
        var container = byId('bonus-vs-rows');
        if (!container) return;
        var bonus = {};
        container.querySelectorAll('.bonus-row').forEach(function (row) {
            var elementId = row.querySelector('[data-bonus-element]')?.value;
            var multiplier = numberValue(row.querySelector('[data-bonus-value]')?.value, 0);
            if (!elementId || !Number.isFinite(multiplier) || multiplier <= 0) return;
            bonus[elementId] = multiplier;
        });
        if (Object.keys(bonus).length) skill.bonus_vs_elements = bonus;
        else delete skill.bonus_vs_elements;
    }

    function renderCollateral(skill) {
        var collateral = skill.collateral;
        var enabled = Boolean(collateral);
        var form = byId('skill-editor');
        form.elements.collateral_enabled.checked = enabled;
        byId('skill-editor').querySelector('.collateral-fields').hidden = !enabled;
        if (!enabled) return;
        form.elements.collateral_target.value = collateral.apply_to || 'both_teams';
        var chance = Number(collateral.chance ?? 1);
        form.elements.collateral_chance.value = Math.round(chance <= 1 ? chance * 100 : chance);
        var multiplier = collateral.damage_multiplier;
        form.elements.collateral_multiplier_min.value = Array.isArray(multiplier) ? multiplier[0] : (multiplier ?? 0.5);
        form.elements.collateral_multiplier_max.value = Array.isArray(multiplier) ? multiplier[1] : (multiplier ?? 0.5);
        form.elements.collateral_include_primary.checked = Boolean(collateral.include_primary_targets ?? collateral.include_primary_target);
        form.elements.collateral_include_caster.checked = Boolean(collateral.include_caster);
    }

    function renderInspector() {
        var report = Model.validate(state.project);
        var errors = report.errors || [];
        var warnings = report.warnings || [];
        byId('validation-mark').textContent = errors.length ? '!' : '✓';
        byId('validation-mark').classList.toggle('has-errors', errors.length > 0);
        var summary = '<strong class="' + (errors.length ? 'error-text' : 'ok-text') + '">'
            + (errors.length ? errors.length + ' erro(s)' : 'Sem erros') + '</strong>';
        if (warnings.length) summary += '<span class="muted-label">· ' + warnings.length + ' aviso(s)</span>';
        byId('validation-summary').innerHTML = summary;
        var items = errors.map(function (issue) {
            return '<button type="button" class="validation-item error" data-error-path="' + escapeHtml(issue.path || '') + '"><span>!</span><div><p>' + escapeHtml(issue.message) + '</p><code>' + escapeHtml(issue.path || '') + '</code><small>Ir para o campo ↗</small></div></button>';
        }).concat(warnings.map(function (issue) {
            return '<button type="button" class="validation-item warning" data-error-path="' + escapeHtml(issue.path || '') + '"><span>!</span><div><p>' + escapeHtml(issue.message) + '</p><code>' + escapeHtml(issue.path || '') + '</code></div></button>';
        }));
        byId('validation-list').innerHTML = items.length ? items.slice(0, 12).join('')
            : '<div class="validation-empty"><span>✓</span><p>As skills e pré-requisitos estão coerentes.</p></div>';
        renderPathPreview();
    }

    function handleValidationClick(event) {
        var button = event.target.closest('[data-error-path]');
        if (!button) return;
        var path = button.dataset.errorPath;
        var orderedSkills = state.project.skills.slice().sort(function (a, b) { return b.id.length - a.id.length; });
        var skill = orderedSkills.find(function (candidate) { return path.startsWith('skills.' + candidate.id + '.'); });
        if (!skill) return;

        state.selectedSkillId = skill.id;
        state.elementFilter = 'all';
        state.search = '';
        state.prerequisiteSearch = '';
        byId('element-filter').value = 'all';
        byId('skill-search').value = '';
        byId('prerequisite-search').value = '';
        setView('skills');
        renderAll();

        window.requestAnimationFrame(function () {
            var target = findFieldForIssue(skill, path, button.querySelector('p')?.textContent || '');
            if (!target) return;
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.focus({ preventScroll: true });
        });
    }

    function findFieldForIssue(skill, path, message) {
        var prefix = 'skills.' + skill.id + '.';
        var fieldPath = path.slice(prefix.length);
        if (fieldPath === 'name') return byId('skill-editor').elements.name;
        if (fieldPath === 'description') return byId('skill-editor').elements.description;
        if (fieldPath === 'element_id') return byId('skill-editor').elements.element_id;
        if (fieldPath.startsWith('learning_cost')) return byId('skill-editor').elements.xp_cost;
        if (fieldPath.startsWith('learning_requirements')) {
            var missing = /não encontrado:\s*(.+)$/i.exec(message);
            if (missing) {
                var remove = Array.from(document.querySelectorAll('[data-remove-prerequisite]')).find(function (item) {
                    return item.dataset.removePrerequisite === missing[1];
                });
                if (remove) return remove;
            }
            return document.querySelector('[data-prerequisite]:checked') || byId('prerequisite-search');
        }
        if (fieldPath.startsWith('damage')) {
            return fieldPath.includes('kind') ? byId('skill-editor').elements.damage_type : byId('skill-editor').elements.power_value;
        }
        if (fieldPath === 'solar') return byId('skill-editor').elements.solar;
        if (fieldPath.startsWith('bonus_vs_elements')) {
            var bonusSection = document.querySelector('.traits-section');
            if (bonusSection) bonusSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return document.querySelector('[data-bonus-value]') || byId('btn-add-bonus-vs');
        }
        if (fieldPath === 'accuracy') return byId('skill-editor').elements.accuracy;
        if (fieldPath === 'hit_count') return byId('skill-editor').elements.hit_count;
        if (fieldPath.startsWith('costs')) {
            var costField = fieldPath.split('.').pop();
            return byId('skill-editor').elements[costField + '_cost'] || byId('skill-editor').elements.cooldown;
        }
        var effectMatch = /^effects\[(\d+)\](?:\.(.+))?/.exec(fieldPath);
        if (effectMatch) {
            var effect = skill.effects?.[Number(effectMatch[1])];
            if (!effect) return byId('skill-editor').elements.name;
            var scope = effect.apply_to === 'self' ? 'self'
                : ['allies_all', 'enemies_all', 'both_teams'].includes(effect.apply_to) ? 'team' : 'target';
            state.openScopes[skill.id] = state.openScopes[skill.id] || {};
            state.openScopes[skill.id][scope] = true;
            renderEffectScopes(skill);
            var card = Array.from(document.querySelectorAll('[data-effect-card]')).find(function (item) {
                return item.dataset.effectId === effect.effect_id;
            });
            if (!card) return document.querySelector('[data-pattern-buttons="' + scope + '"] button');
            var property = effectMatch[2] || '';
            var advanced = card.querySelector('.effect-advanced');
            if (property.includes('polarity') || property.includes('immunities') || property.includes('prevent_actions')) {
                if (advanced) advanced.open = true;
            }
            if (property.includes('element_id')) return card.querySelector('[data-effect-field="element_id"]');
            if (property.includes('effect_id')) return card.querySelector('[data-effect-field="status_effect"]');
            if (property.includes('cleanse') || property.includes('dispel')) return card.querySelector('[data-effect-field="' + property.split('.')[0] + '"]');
            if (property.includes('damage')) return card.querySelector('[data-effect-field="damage_per_turn"]') || card.querySelector('[data-effect-pattern]');
            if (property.includes('regen_per_turn')) return card.querySelector('[data-effect-resource="regen_per_turn.hp"]') || card.querySelector('[data-effect-pattern]');
            if (property.includes('buff') || property.includes('debuff')) return card.querySelector('[data-stat-value]') || card.querySelector('[data-effect-pattern]');
            return card.querySelector('[data-effect-field="status_effect"]') || card.querySelector('[data-effect-pattern]');
        }
        if (fieldPath.startsWith('collateral')) {
            var details = document.querySelector('.collateral-section');
            details.open = true;
            var field = fieldPath.split('.').pop();
            if (field.includes('apply_to')) return byId('skill-editor').elements.collateral_target;
            return byId('skill-editor').elements.collateral_enabled;
        }
        return byId('skill-editor').elements.name;
    }

    function renderPathPreview() {
        var skill = currentSkill();
        var container = byId('path-preview');
        if (!skill) { container.innerHTML = '<p class="muted-label">Seleciona uma skill para ver o caminho.</p>'; return; }
        var path = Model.calculatePath(skill.id, state.project);
        var total = path.reduce(function (sum, item) { return sum + (Number(item.learning_cost?.experience_points) || 0); }, 0);
        container.innerHTML = '<div class="path-total"><span>CUSTO ACUMULADO</span><strong>' + total + ' XP</strong></div><div class="path-steps">'
            + path.map(function (item, index) {
                var cross = index > 0 && path[index - 1].element_id !== item.element_id;
                return (index ? '<span class="path-connector">↓</span>' : '') + '<div class="path-step ' + (item.id === skill.id ? 'is-current' : '') + '"><span class="path-identity"><strong>' + escapeHtml(item.name) + '</strong><small>' + escapeHtml(item.element_id) + '</small></span><b>' + (Number(item.learning_cost?.experience_points) || 0) + ' XP</b></div>';
            }).join('') + '</div>';
    }

    /* ------------------------------------------------------------------ */
    /* Simulador — a mesma cadeia do motor, sem críticos nem variância.   */
    /* ------------------------------------------------------------------ */
    function simulatorSkill() {
        var skills = state.project.skills;
        if (!skills.length) return null;
        return skills.find(function (skill) { return skill.id === state.simulator.skillId; })
            || skills.find(function (skill) { return skill.id === state.selectedSkillId; })
            || skills[0];
    }

    function renderSimulator() {
        var select = byId('sim-skill');
        var skills = sortedSkills(state.project.skills);
        var skill = simulatorSkill();
        if (skill) state.simulator.skillId = skill.id;
        select.innerHTML = skills.length
            ? skills.map(function (item) {
                return optionMarkup(item.id, item.name + ' · ' + item.element_id, item.id === (skill && skill.id));
            }).join('')
            : '';
        if (skill) select.value = skill.id;
        renderSimulatorElements();
        var result = byId('sim-result');
        if (!skill) {
            result.innerHTML = '<div class="sim-empty"><h2>Sem skills para simular</h2><p>Cria uma skill — ou importa um <code>skills.yaml</code> — e volta aqui.</p></div>';
            return;
        }
        var sim = Engine.simulate(skill, {
            attackerPhysicalAttack: state.simulator.attackerPhysicalAttack,
            attackerMagicalAttack: state.simulator.attackerMagicalAttack,
            attackerSpeed: state.simulator.attackerSpeed,
            attackerAccuracyStat: state.simulator.attackerAccuracyStat,
            attackerCritStat: state.simulator.attackerCritStat,
            attackerLine: state.simulator.attackerLine,
            defenderPhysicalDefense: state.simulator.defenderPhysicalDefense,
            defenderMagicalDefense: state.simulator.defenderMagicalDefense,
            defenderEvasion: state.simulator.defenderEvasion,
            defenderLine: state.simulator.defenderLine,
            defenderDefending: state.simulator.defenderDefending,
            defenderElements: state.simulator.defenderElements,
            defenderStatuses: state.simulator.defenderStatuses,
            targetHpFraction: (numberValue(state.simulator.targetHpPercent, 100) || 0) / 100,
            phase: state.simulator.phase,
            level: state.simulator.level,
        });
        result.innerHTML = simulatorReport(skill, sim);
    }

    function renderSimulatorElements() {
        var container = byId('sim-elements');
        if (!container) return;
        var selected = new Set(state.simulator.defenderElements);
        container.innerHTML = Engine.elementIds().map(function (id) {
            return '<label class="sim-element"><input type="checkbox" data-element="' + escapeHtml(id) + '" ' + (selected.has(id) ? 'checked' : '') + '><span>' + escapeHtml(id) + '</span></label>';
        }).join('');
    }

    /** Escreve o estado nos campos — só quando se entra no simulador ou se repõe. */
    function syncSimulatorInputs() {
        byId('sim-attack-physical').value = state.simulator.attackerPhysicalAttack;
        byId('sim-attack-magical').value = state.simulator.attackerMagicalAttack;
        byId('sim-attacker-speed').value = state.simulator.attackerSpeed;
        byId('sim-attacker-accuracy').value = state.simulator.attackerAccuracyStat;
        byId('sim-attacker-crit').value = state.simulator.attackerCritStat;
        byId('sim-attacker-line').value = state.simulator.attackerLine;
        byId('sim-defense-physical').value = state.simulator.defenderPhysicalDefense;
        byId('sim-defense-magical').value = state.simulator.defenderMagicalDefense;
        byId('sim-defender-evasion').value = state.simulator.defenderEvasion;
        byId('sim-target-hp').value = state.simulator.targetHpPercent;
        byId('sim-defender-line').value = state.simulator.defenderLine;
        byId('sim-defender-statuses').value = (state.simulator.defenderStatuses || []).join(', ');
        byId('sim-defending').checked = state.simulator.defenderDefending;
        byId('sim-phase').value = state.simulator.phase;
        byId('sim-level').value = state.simulator.level;
    }

    function simulatorReport(skill, sim) {
        if (!sim.hasDamage) {
            return '<div class="sim-empty"><h2>' + escapeHtml(skill.name) + '</h2>'
                + '<p>Esta skill não causa dano direto, por isso não há número de dano a simular. '
                + 'Os efeitos que ela aplica continuam a valer: ' + escapeHtml(effectSummary(skill)) + '</p>'
                + (sim.phaseLock ? '<span class="sim-block-note">' + escapeHtml(sim.phaseLock) + '</span>' : '')
                + '</div>';
        }
        var damageLabel = sim.damageType === 'physical' ? 'físico' : 'mágico';
        var rows = [];
        var defenseLabel = sim.defenseValue + (sim.pierced.fraction ? ' − ' + Math.round(sim.pierced.fraction * 100) + '% ignorada' : '');
        rows.push(['Ataque ÷ Defesa', sim.attackValue + ' ÷ ' + defenseLabel + ' = ' + round(sim.attackValue / Math.max(1, sim.effectiveDefense), 2)]);
        rows.push(['Elemento (' + skill.element_id + ')', '×' + sim.element.multiplier + ' — ' + sim.element.relation]);
        if (sim.phase !== 1) {
            rows.push([(skill.lunar ? 'Noturna' : 'Solar') + ' (' + (state.simulator.phase === 'night' ? 'noite' : 'dia') + ')', '×' + sim.phase]);
        }
        if (sim.bonus.multiplier !== 1) {
            rows.push(['Bónus contra ' + sim.bonus.element, '×' + sim.bonus.value]);
        }
        if (sim.hpBonus.multiplier !== 1) {
            rows.push(['Alvo enfraquecido (< ' + Math.round(sim.hpBonus.threshold * 100) + '% de vida)', '×' + sim.hpBonus.value]);
        }
        rows.push(['Linha (' + (state.simulator.attackerLine === 'front' ? 'frente' : 'trás') + ' → ' + (state.simulator.defenderLine === 'front' ? 'frente' : 'trás') + ')', '×' + sim.position]);
        if (sim.defenseReduction) rows.push(['Alvo a defender', '×' + (1 - sim.defenseReduction)]);

        var rangeNote = sim.minDamage !== null
            ? '<p class="sim-note">Com poder sorteado, o acerto fica entre <strong>' + sim.minDamage + '</strong> e <strong>' + sim.maxDamage + '</strong>.</p>'
            : '';

        var critNote = sim.critChance > 0
            ? '<div><span>Crítico</span><strong>' + Math.round(sim.critChance) + '% · ×' + sim.critMultiplier + '</strong></div>'
            : '';
        var guaranteed = sim.guaranteedCrit
            ? '<div><span>Crítico garantido contra</span><strong>' + escapeHtml(sim.guaranteedCrit) + '</strong></div>'
            : '';
        var flee = sim.fleeBelowHp !== null
            ? '<div><span>Alvo foge abaixo de</span><strong>' + Math.round(sim.fleeBelowHp * 100) + '% de vida</strong></div>'
            : '';
        var blockedNote = sim.phaseLock
            ? '<div class="is-blocked"><span>Fase</span><strong>' + escapeHtml(sim.phaseLock) + '</strong></div>'
            : '';
        var drainNote = sim.drainPercent !== null
            ? '<div><span>Drena</span><strong>' + Math.round(sim.drainPercent * 100) + '% do dano → '
                + sim.drainHeal + ' de cura a quem usa</strong></div>'
            : '';
        var mechanicsHtml = effectMechanicNotes(skill).map(function (note) {
            return '<div><span>Mecânica</span><strong>' + escapeHtml(note) + '</strong></div>';
        }).join('');

        return '<div class="sim-head">'
            + '<div><span class="eyebrow">' + escapeHtml(skill.element_id) + ' · nível ' + sim.tier.label + '</span>'
            + '<h2>' + escapeHtml(skill.name) + '</h2>'
            + '<p>Dano ' + damageLabel + ' · poder ' + round(sim.power, 1) + ' · ' + sim.hitCount + (sim.hitCount > 1 ? ' golpes' : ' golpe') + '</p></div>'
            + '</div>'
            + '<div class="sim-headline">'
            + '<div class="sim-figure sim-figure-main"><span>Dano por acerto</span><strong>' + sim.finalDamage + '</strong></div>'
            + '<div class="sim-figure"><span>Dano esperado por uso</span><strong>' + round(sim.expectedTotal, 1) + '</strong></div>'
            + '<div class="sim-figure"><span>Chance de acerto</span><strong>' + Math.round(sim.hitChance * 100) + '%</strong></div>'
            + '<div class="sim-figure"><span>Golpes esperados</span><strong>' + round(sim.expectedHits, 2) + '</strong></div>'
            + '</div>'
            + rangeNote
            + '<div class="sim-chain">'
            + rows.map(function (row) {
                return '<div class="sim-chain-row"><span>' + escapeHtml(row[0]) + '</span><strong>' + escapeHtml(row[1]) + '</strong></div>';
            }).join('')
            + '<div class="sim-chain-row is-total"><span>Dano por acerto</span><strong>' + sim.finalDamage + '</strong></div>'
            + '</div>'
            + '<div class="sim-meta">'
            + blockedNote
            + '<div><span>Custo</span><strong>' + (sim.costs.mana ? sim.costs.mana + ' MP' : 'sem mana') + (sim.costs.stamina ? ' · ' + sim.costs.stamina + ' ST' : '') + (sim.costs.hp ? ' · ' + sim.costs.hp + ' HP' : '') + (sim.costs.cooldown ? ' · ' + sim.costs.cooldown + ' turnos' : '') + '</strong></div>'
            + (sim.manaPerDamage !== null ? '<div><span>Mana por ponto de dano</span><strong>' + round(sim.manaPerDamage, 2) + '</strong></div>' : '')
            + '<div><span>Precisão</span><strong>' + Math.round(sim.accuracy.authored) + '% + ' + Math.round(sim.accuracy.modifier) + (sim.accuracy.evasion ? ' − ' + Math.round(sim.accuracy.evasion) + ' esquiva' : '') + ' = ' + Math.round(sim.accuracy.value) + '%</strong></div>'
            + critNote + guaranteed + flee
            + drainNote
            + mechanicsHtml
            + '<div><span>Nível</span><strong>' + sim.tier.label + ' · poder ×' + round(sim.tier.powerFactor, 2) + ' · custo ×' + round(sim.tier.costFactor, 2) + '</strong></div>'
            + '</div>'
            + '<p class="sim-note">' + (sim.scalingNote ? escapeHtml(sim.scalingNote) + ' ' : '')
            + (sim.chaosNote ? escapeHtml(sim.chaosNote) + ' ' : '')
            + 'Sem críticos e sem a variância (0.9 … 1.1): este é o valor esperado de um acerto, não uma tiragem.</p>';
    }

    /** Notas de mecânica nova que os efeitos pedem ao motor. */
    function effectMechanicNotes(skill) {
        var notes = [];
        (skill.effects || []).forEach(function (effect) {
            if (effect.detonate_on_turn) {
                notes.push('Detona no turno do portador: ' + effect.detonate_on_turn.power + ' PWR'
                    + (effect.detonate_on_turn.include_line ? ' na linha' : '')
                    + (effect.detonate_on_turn.turn_skip_chance ? ' · ' + Math.round(effect.detonate_on_turn.turn_skip_chance * 100) + '% de perder o turno' : ''));
            }
            if (effect.chain_detonation) notes.push('Marca em cadeia: +' + effect.chain_detonation.power + ' PWR quando outro Chaos acerta');
            if (effect.conductor) notes.push('Condutor: salta ' + effect.conductor.jump_power + ' PWR para o inimigo mais próximo');
            if (effect.interrupt) notes.push('Interrupção: ' + Math.round(effect.interrupt.chance * 100) + '% de falhar a ação vigiada');
            if (effect.reflect) notes.push('Reflete ' + effect.reflect.power + ' PWR fixo');
            if (effect.spend_steal) notes.push('Rouba ' + (effect.spend_steal.amount ? effect.spend_steal.amount : Math.round((effect.spend_steal.percent || 0) * 100) + '%') + ' do próximo gasto');
            if (effect.evade_next) notes.push('Esquiva o próximo golpe (' + (effect.evade_next.damage_types || ['qualquer']).join('/') + ') e riposta ' + (effect.evade_next.power || 0) + ' PWR');
            if (effect.damage_redirect) notes.push('Cobre os aliados e recebe o dano no lugar deles');
            if (effect.cost_multiplier) notes.push('Custos ×' + (effect.cost_multiplier.mana ?? 1) + ' mana / ×' + (effect.cost_multiplier.stamina ?? 1) + ' stamina');
            if (effect.end_cost) notes.push('Ao terminar paga ' + effect.end_cost.percent_of_max + '% do recurso (falta vai à vida)');
            if (effect.on_death_blast) notes.push('Ao cair devolve ' + effect.on_death_blast.power + ' PWR');
            if (effect.confuse) {
                var chance = effect.confusion_chance === undefined || effect.confusion_chance === null
                    ? 50 : Math.round(Number(effect.confusion_chance) * 100);
                notes.push('Confunde: com chance de ' + chance + '%, o golpe recai sobre um aliado do alvo');
            }
            if (effect.set_phase) {
                notes.push('Força a fase ' + (effect.set_phase === 'night' ? 'noite' : 'dia') + ' por ' + (effect.phase_rounds ?? 5) + ' ronda(s)');
            }
            if (effect.removable_by_lux) notes.push('Removível por Lux: qualquer ataque de Lux levanta o estado');
            if (effect.random_debuff && typeof effect.random_debuff === 'object') {
                notes.push('Reduz ' + (effect.random_debuff.count ?? 1) + ' atributo(s) aleatório(s) em '
                    + (effect.random_debuff.amount ?? '') + ' por ' + (effect.turns || 1) + ' turno(s)');
            }
            if (effect.random_buff && typeof effect.random_buff === 'object') {
                notes.push('Levanta ' + (effect.random_buff.count ?? 1) + ' atributo(s) aleatório(s) em '
                    + (effect.random_buff.amount ?? '') + ' por ' + (effect.turns || 1) + ' turno(s)');
            }
            if (effect.heal_on_kill !== undefined || effect.heal_on_kill_percent !== undefined) {
                var killHeal = [];
                if (effect.heal_on_kill !== undefined && effect.heal_on_kill !== null) killHeal.push(String(effect.heal_on_kill));
                if (effect.heal_on_kill_percent !== undefined && effect.heal_on_kill_percent !== null) {
                    killHeal.push(Math.round(Number(effect.heal_on_kill_percent) * 100) + '% da vida máxima');
                }
                notes.push('Cura ' + killHeal.join(' + ') + ' ao portador por cada morte no campo');
            }
            if (effect.random_targets && typeof effect.random_targets === 'object') {
                var minTargets = effect.random_targets.min ?? 1;
                notes.push(effect.random_targets.max === undefined || effect.random_targets.max === null
                    ? 'Atinge até ' + minTargets + ' unidade(s) do âmbito ao acaso'
                    : 'Atinge entre ' + minTargets + ' e ' + effect.random_targets.max + ' unidades do âmbito ao acaso');
            }
            if (effect.locks_target) notes.push('Quem usa não pode trocar de alvo durante o efeito');
            if (effect.invert_buffs) notes.push('Inverte os buffs ativos do alvo');
            if (Array.isArray(effect.damage_immunities) && effect.damage_immunities.length) {
                notes.push('O portador está imune a dano ' + effect.damage_immunities.map(function (channel) {
                    return channel === 'physical' ? 'físico' : channel === 'magical' ? 'mágico' : channel;
                }).join(' e '));
            }
        });
        return notes;
    }

    function effectSummary(skill) {
        var effects = skill.effects || [];
        if (!effects.length) return 'não aplica nenhum efeito.';
        var text = effects.map(function (effect) {
            return (effect.status_effect || effect.effect_id || 'efeito');
        }).join(', ') + '.';
        var notes = effectMechanicNotes(skill);
        if (notes.length) text += ' Notas: ' + notes.join('; ') + '.';
        return text;
    }

    function round(value, decimals) {
        var factor = Math.pow(10, decimals || 0);
        return Math.round((Number(value) || 0) * factor) / factor;
    }

    function renderTree() {
        Model.ensureTree(state.project, state.treeElement);
        byId('tree-title').textContent = 'Árvore de ' + state.treeElement;
        byId('tree-subtitle').textContent = state.treeElement;
        renderTreeCanvas();
    }

    function renderTreeCanvas() {
        var skills = state.project.skills.filter(function (skill) { return skill.element_id === state.treeElement; });
        var nodes = byId('tree-nodes');
        byId('tree-skill-count').textContent = skills.length;
        byId('tree-empty').hidden = skills.length > 0;
        applyZoom();
        if (!skills.length) {
            nodes.innerHTML = '';
            byId('tree-edges').innerHTML = '';
            state.treeLayout = null;
            return;
        }
        var layout = Model.layout(state.project, state.treeElement);
        state.treeLayout = layout;
        nodes.style.width = layout.width + 'px';
        nodes.style.height = layout.height + 'px';
        byId('tree-edges').style.width = layout.width + 'px';
        byId('tree-edges').style.height = layout.height + 'px';
        nodes.innerHTML = skills.map(function (skill, index) {
            var point = layout.positions.get(skill.id);
            var requirements = skill.learning_requirements?.required_attack_ids || [];
            var external = requirements.map(function (id) { return state.project.skills.find(function (item) { return item.id === id; }); })
                .filter(function (item) { return item && item.element_id !== state.treeElement; });
            return '<article class="tree-node ' + (skill.id === state.selectedSkillId ? 'is-focused' : '') + '" data-skill-node="' + escapeHtml(skill.id) + '" draggable="false" style="left:' + point.x + 'px;top:' + point.y + 'px">'
                + '<div class="node-topline"><span class="node-element">' + escapeHtml(skill.element_id) + '</span></div>'
                + '<div class="tree-node-main"><strong>' + escapeHtml(skill.name) + '</strong><code>' + escapeHtml(skill.id) + '</code></div>'
                + '<div class="node-bottomline"><span>' + (Number(skill.learning_cost?.experience_points) || 0) + ' XP</span><span>' + (requirements.length ? '↳ ' + requirements.length + ' pré-req.' : 'Raiz') + '</span></div>'
                + (external.length ? '<div class="cross-tree-tag" title="' + escapeHtml('Pré-requisito externo: ' + external.map(function (item) { return item.element_id + ' · ' + item.id; }).join(' · ')) + '">'
                    + external.map(function (item) { return '<span>↗ ' + escapeHtml(item.element_id) + ' · ' + escapeHtml(item.id) + '</span>'; }).join('')
                    + '</div>' : '')
                + '</article>';
        }).join('');
        renderEdges(skills, layout);
    }

    function renderEdges(skills, layout) {
        var svg = byId('tree-edges');
        var positions = layout.positions;
        var markup = [];
        var activePath = new Set(Model.calculatePath(state.selectedSkillId, state.project).map(function (skill) { return skill.id; }));
        skills.forEach(function (skill) {
            var sameTreeRequirements = Array.from(new Set(skill.learning_requirements?.required_attack_ids || []))
                .filter(function (id) { return positions.has(id); })
                .sort(function (a, b) { return positions.get(a).x - positions.get(b).x; });
            sameTreeRequirements.forEach(function (requiredId, edgeIndex) {
                var from = positions.get(requiredId);
                var to = positions.get(skill.id);
                if (!from || !to) return;
                var startX = from.x + 102.5;
                var startY = from.y + 100;
                var targetSpacing = Math.min(30, 180 / Math.max(1, sameTreeRequirements.length - 1));
                var endX = to.x + 102.5 + (edgeIndex - (sameTreeRequirements.length - 1) / 2) * targetSpacing;
                var endY = to.y - 1;
                var middleY = startY + (endY - startY) / 2;
                var highlighted = activePath.has(requiredId) && activePath.has(skill.id);
                var path = 'M ' + startX + ' ' + startY + ' V ' + middleY + ' H ' + endX + ' V ' + endY;
                markup.push('<path class="tree-edge' + (highlighted ? ' is-highlighted' : '') + '" d="' + path + '" marker-end="url(#edge-arrow)"></path>');
            });
        });
        svg.setAttribute('viewBox', '0 0 ' + layout.width + ' ' + layout.height);
        svg.innerHTML = '<defs><marker id="edge-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L7,4 L0,8 z" class="edge-arrow"></path></marker></defs>' + markup.join('');
    }

    function handleEditorInput(event) {
        var skill = currentSkill();
        if (!skill) return;
        // A partir de aqui a descrição é do autor: o Forger deixa de a reescrever.
        if (event.target.name === 'description') state.autoDescription[skill.id] = false;
        if (event.target.closest('.bonus-row')) {
            syncBonusVs(skill);
            persist();
            renderInspector();
            renderSkillSummary(skill);
            return;
        }
        if (!event.target.name) return;
        syncSkillFromEditor(skill);
        if (event.target.name === 'power_kind') updatePowerFields(true);
        if (event.target.name === 'element_id') renderEffectScopes(skill);
        persist();
        updateEditorFeedback(skill, event.target.name === 'element_id');
        if (event.target.name === 'description') updateDescriptionCounter();
    }

    function handleEditorChange(event) {
        var skill = currentSkill();
        if (!skill) return;
        if (event.target.closest('.bonus-row')) {
            syncBonusVs(skill);
            persist();
            renderInspector();
            renderSkillSummary(skill);
            return;
        }
        if (!event.target.name) return;
        syncSkillFromEditor(skill);
        if (event.target.name === 'direct_action') updateDirectActionFields();
        if (event.target.name === 'power_kind') updatePowerFields(true);
        if (event.target.name === 'targeting') {
            updateTargetContext(skill);
            renderEffectScopes(skill);
        }
        if (event.target.name === 'collateral_target') syncCollateral(skill);
        if (event.target.name === 'element_id') renderEffectScopes(skill);
        persist();
        updateEditorFeedback(skill, event.target.name === 'element_id');
    }

    function syncSkillFromEditor(skill) {
        var form = byId('skill-editor');
        var oldElement = skill.element_id;
        skill.name = form.elements.name.value;
        skill.element_id = form.elements.element_id.value;
        skill.description = form.elements.description.value;
        skill.learning_cost = { experience_points: numberValue(form.elements.xp_cost.value, 0) };
        skill.learning_requirements = {
            required_attack_ids: Array.from(state.prerequisiteSelection),
        };
        skill.targeting = form.elements.targeting.value;
        skill.costs = {
            mana: numberValue(form.elements.mana_cost.value, 0),
            stamina: numberValue(form.elements.stamina_cost.value, 0),
            hp: numberValue(form.elements.hp_cost.value, 0),
            cooldown: numberValue(form.elements.cooldown.value, 0),
        };
        if (form.elements.solar.checked) skill.solar = true;
        else delete skill.solar;
        if (form.elements.lunar.checked) skill.lunar = true;
        else delete skill.lunar;
        if (form.elements.only_during_day.checked) skill.only_during_day = true;
        else delete skill.only_during_day;
        if (form.elements.only_during_night.checked) skill.only_during_night = true;
        else delete skill.only_during_night;
        if (form.elements.ignore_accuracy.checked) skill.ignore_accuracy = true;
        else delete skill.ignore_accuracy;
        setOptionalNumber(skill, 'crit_chance', form.elements.crit_chance.value);
        if (form.elements.crit_multiplier) setOptionalNumber(skill, 'crit_multiplier', form.elements.crit_multiplier.value);
        setOptionalNumber(skill, 'defense_pierce', form.elements.defense_pierce.value);
        setOptionalNumber(skill, 'flee_below_hp', form.elements.flee_below_hp.value);
        if (form.elements.guaranteed_crit_vs_status.value.trim()) {
            skill.guaranteed_crit_vs_status = form.elements.guaranteed_crit_vs_status.value.trim();
        } else {
            delete skill.guaranteed_crit_vs_status;
        }
        var hpThreshold = form.elements.bonus_vs_hp_below_threshold.value;
        var hpMultiplier = form.elements.bonus_vs_hp_below_multiplier.value;
        if (hpThreshold !== '' && hpMultiplier !== '') {
            skill.bonus_vs_hp_below = { threshold: numberValue(hpThreshold, 0), multiplier: numberValue(hpMultiplier, 1) };
        } else {
            delete skill.bonus_vs_hp_below;
        }
        var bonusStatus = form.elements.bonus_vs_status_status.value.trim();
        var bonusMultiplier = form.elements.bonus_vs_status_multiplier.value;
        var bonusPierce = form.elements.bonus_vs_status_pierce.value;
        if (bonusStatus) {
            skill.bonus_vs_status = {
                status: bonusStatus,
                multiplier: bonusMultiplier !== '' ? Math.max(1, numberValue(bonusMultiplier, 1)) : 1,
                defense_pierce: bonusPierce !== '' ? Math.min(1, Math.max(0, numberValue(bonusPierce, 0))) : 0,
            };
        } else {
            delete skill.bonus_vs_status;
        }
        var chargeStatus = form.elements.bonus_per_charge_status.value.trim();
        var chargeMultiplier = form.elements.bonus_per_charge_multiplier.value;
        if (chargeStatus && chargeMultiplier !== '') {
            skill.bonus_per_charge = {
                status: chargeStatus,
                multiplier_per_charge: numberValue(chargeMultiplier, 0),
                consume: form.elements.bonus_per_charge_consume.checked,
            };
            if (!skill.bonus_per_charge.consume) delete skill.bonus_per_charge.consume;
        } else {
            delete skill.bonus_per_charge;
        }

        var recoilHp = form.elements.recoil_hp ? numberValue(form.elements.recoil_hp.value, 0) : 0;
        if (recoilHp > 0) skill.recoil = { hp: recoilHp };
        else delete skill.recoil;

        var friendlyDamage = form.elements.friendly_fire_damage
            ? numberValue(form.elements.friendly_fire_damage.value, 0) : 0;
        if (friendlyDamage > 0) {
            skill.friendly_fire = { damage: friendlyDamage, chance: 1, scope: 'allies_all' };
        } else {
            delete skill.friendly_fire;
        }

        var backlanePower = form.elements.backlane_power
            ? numberValue(form.elements.backlane_power.value, 0) : 0;
        var backlanePercent = form.elements.backlane_percent
            ? Math.max(0, Math.min(1, numberValue(form.elements.backlane_percent.value, 0) / 100)) : 0;
        if (backlanePower > 0 || backlanePercent > 0) {
            skill.backlane_splash = {
                power: backlanePower,
                percent_of_damage: backlanePercent,
                chance: Math.min(1, Math.max(0,
                    numberValue(form.elements.backlane_chance.value, 30) / 100)),
                both: true,
            };
        } else {
            delete skill.backlane_splash;
        }

        var noSpaceFraction = form.elements.no_space_recoil_fraction
            ? numberValue(form.elements.no_space_recoil_fraction.value, 0) : 0;
        if (noSpaceFraction > 0) skill.no_space_recoil = { fraction: Math.min(1, noSpaceFraction) };
        else delete skill.no_space_recoil;

        var controlDamage = form.elements.control_immune_damage
            ? numberValue(form.elements.control_immune_damage.value, 0) : 0;
        if (controlDamage > 0) skill.control_immune_damage = controlDamage;
        else delete skill.control_immune_damage;

        var onKillPower = form.elements.on_kill_detonation_power
            ? numberValue(form.elements.on_kill_detonation_power.value, 0) : 0;
        if (onKillPower > 0) skill.on_kill_detonation = { power: onKillPower, include_allies: true };
        else delete skill.on_kill_detonation;

        var chainJumps = form.elements.chain_jumps
            ? numberValue(form.elements.chain_jumps.value, 0) : 0;
        if (chainJumps > 0) {
            skill.chain = {
                chance: Math.min(1, Math.max(0,
                    numberValue(form.elements.chain_chance.value, 100) / 100)),
                jumps: chainJumps,
                power_percent: Math.min(1, Math.max(0,
                    numberValue(form.elements.chain_power_percent.value, 60) / 100)),
                accuracy: numberValue(skill.accuracy, 95),
                weighted_backlane: true,
            };
            var chainBranches = numberValue(form.elements.chain_branches.value, 1);
            if (chainBranches > 1) skill.chain.branches = chainBranches;
        } else {
            delete skill.chain;
        }

        var shrapnelCount = form.elements.shrapnel_count
            ? numberValue(form.elements.shrapnel_count.value, 0) : 0;
        if (shrapnelCount > 0) {
            skill.shrapnel = {
                count: shrapnelCount,
                power: numberValue(form.elements.shrapnel_power.value, 5),
                accuracy: 40,
                include_allies: true,
            };
        } else {
            delete skill.shrapnel;
        }

        var instabilityDamage = form.elements.instability_self_damage
            ? numberValue(form.elements.instability_self_damage.value, 0) : 0;
        if (instabilityDamage > 0) {
            skill.instability = {
                status: 'Instability',
                max: 3,
                damage_per_charge: 0.1,
                self_damage: instabilityDamage,
                self_damage_chance: 0.25,
                turns: 3,
            };
        } else {
            delete skill.instability;
        }

        var cooldownResetStatus = form.elements.cooldown_reset_status
            ? form.elements.cooldown_reset_status.value.trim() : '';
        if (cooldownResetStatus) {
            skill.cooldown_reset = {
                status: cooldownResetStatus,
                amount: Math.max(1, numberValue(form.elements.cooldown_reset_amount.value, 1)),
            };
        } else {
            delete skill.cooldown_reset;
        }

        var damageTakenPerPoint = form.elements.damage_taken_scaling_per_point
            ? numberValue(form.elements.damage_taken_scaling_per_point.value, 0) : 0;
        if (damageTakenPerPoint > 0) skill.damage_taken_scaling = { per_point: damageTakenPerPoint };
        else delete skill.damage_taken_scaling;

        var effectivenessWeak = form.elements.element_effectiveness_weak
            ? numberValue(form.elements.element_effectiveness_weak.value, 1) : 1;
        var effectivenessResist = form.elements.element_effectiveness_resist
            ? numberValue(form.elements.element_effectiveness_resist.value, 1) : 1;
        if (effectivenessWeak !== 1 || effectivenessResist !== 1) {
            skill.element_effectiveness = { weak: effectivenessWeak, resist: effectivenessResist };
        } else {
            delete skill.element_effectiveness;
        }

        var consumeStatus = form.elements.consume_status
            ? form.elements.consume_status.value.trim() : '';
        if (consumeStatus) {
            skill.consume_stacks = [{
                status: consumeStatus,
                per_stack: form.elements.consume_per_stack
                    ? numberValue(form.elements.consume_per_stack.value, 0) : 0,
                ignore_defense: form.elements.consume_ignore_defense
                    ? form.elements.consume_ignore_defense.checked : false,
                heal_percent_per_stack: form.elements.consume_heal_percent
                    ? numberValue(form.elements.consume_heal_percent.value, 0) : 0,
            }];
        } else {
            delete skill.consume_stacks;
        }
        syncBonusVs(skill);

        if (form.elements.direct_action.value === 'damage') {
            var powerValue = numberValue(form.elements.power_value.value, 0);
            var powerKind = form.elements.power_kind.value;
            if (powerKind === 'attribute') {
                // Escala por atributo vive no nível da skill (o motor lê
                // `power_scaling`), e o poder base do golpe fica fixo.
                var scaledStat = (form.elements.power_stat?.value || 'speed');
                skill.power_scaling = { stat: scaledStat, per_point: Math.max(0, powerValue) };
                skill.damage = { kind: form.elements.damage_type.value, power: { kind: 'fixed', value: powerValue } };
            } else {
                delete skill.power_scaling;
                var power = powerKind === 'random'
                    ? { kind: 'random', min: powerValue, max: numberValue(form.elements.power_max?.value, powerValue) }
                    : { kind: 'fixed', value: powerValue };
                skill.damage = { kind: form.elements.damage_type.value, power: power };
            }
            skill.accuracy = Math.max(0, Math.min(100, numberValue(form.elements.accuracy.value, 100)));
            skill.hit_count = Math.max(1, numberValue(form.elements.hit_count.value, 1));
        } else {
            delete skill.damage;
            delete skill.accuracy;
            delete skill.hit_count;
            delete skill.power_scaling;
        }

        syncEffectCards(skill);
        syncCollateral(skill);
        refreshAutoDescription(skill);

        if (oldElement !== skill.element_id) {
            if (state.project.trees[oldElement]) delete state.project.trees[oldElement].positions[skill.id];
            Model.ensureTree(state.project, skill.element_id);
            Model.position(state.project, skill, state.project.skills.indexOf(skill));
        }
    }

    function updateDirectActionFields() {
        var showDamage = byId('skill-editor').elements.direct_action.value === 'damage';
        document.querySelectorAll('[data-direct-damage]').forEach(function (field) { field.hidden = !showDamage; });
        byId('power-extra').hidden = !showDamage || byId('skill-editor').elements.power_kind.value === 'fixed';
    }

    function updateTargetContext(skill) {
        var target = normalizeTarget(skill?.targeting || byId('skill-editor').elements.targeting.value);
        // A secção própria gere os efeitos apply_to: self. Mantém-na visível
        // também quando o atacante é o alvo principal; a secção do alvo não
        // deve duplicar a pergunta nem esconder os efeitos próprios existentes.
        byId('attacker-effect-section').hidden = false;
        document.querySelector('.target-effects-section').hidden = target === 'self';
        byId('target-effects-title').textContent = target === 'self'
            ? 'O próprio atacante sofre algum efeito?'
            : 'O alvo (' + (TARGET_LABELS[target] || target) + ') sofre algum efeito?';
        updateTeamEffectsContext(skill);
        updateDirectActionFields();
    }

    function handlePrerequisiteChange(event) {
        if (!event.target.matches('[data-prerequisite]')) return;
        var skill = currentSkill();
        if (!skill) return;
        if (event.target.checked) state.prerequisiteSelection.add(event.target.dataset.prerequisite);
        else state.prerequisiteSelection.delete(event.target.dataset.prerequisite);
        syncSkillFromEditor(skill);
        persist();
        renderPrerequisites(skill);
        renderInspector();
        renderTreeCanvas();
    }

    function removePrerequisite(event) {
        var button = event.target.closest('[data-remove-prerequisite]');
        if (!button) return;
        var skill = currentSkill();
        if (!skill) return;
        state.prerequisiteSelection.delete(button.dataset.removePrerequisite);
        syncSkillFromEditor(skill);
        persist();
        renderPrerequisites(skill);
        renderInspector();
        renderTreeCanvas();
    }

    function handleScopeToggle(event) {
        var name = event.target.name;
        var scope = name === 'self_effects_enabled' ? 'self' : name === 'target_effects_enabled' ? 'target' : name === 'team_effects_enabled' ? 'team' : null;
        if (!scope) return;
        var skill = currentSkill();
        if (!skill) return;
        state.openScopes[skill.id] = state.openScopes[skill.id] || {};
        state.openScopes[skill.id][scope] = event.target.checked;
        if (!event.target.checked) {
            var effectsInScope = new Set(scopeEffects(skill, scope));
            skill.effects = (skill.effects || []).filter(function (effect) { return !effectsInScope.has(effect); });
        }
        persist();
        renderEffectScopes(skill);
        renderInspector();
    }

    function handleCollateralToggle(event) {
        if (event.target.name !== 'collateral_enabled') return;
        var skill = currentSkill();
        if (!skill) return;
        if (event.target.checked) {
            skill.collateral = { chance: 1, apply_to: 'both_teams', include_primary_targets: false, include_caster: false, damage_multiplier: [0.5, 0.5] };
        } else delete skill.collateral;
        byId('skill-editor').querySelector('.collateral-fields').hidden = !event.target.checked;
        persist();
    }

    function renderEffectScopes(skill) {
        updateTeamEffectsContext(skill);
        ['self', 'target', 'team'].forEach(function (scope) {
            var group = scopeEffects(skill, scope);
            var checkbox = document.querySelector('[name="' + scope + '_effects_enabled"]');
            var open = state.openScopes[skill.id]?.[scope];
            if (group.length > 0) open = true;
            else if (open === undefined) open = false;
            checkbox.checked = Boolean(open);
            byId(scope + '-effects').parentElement.hidden = !open;
            renderPatternButtons(scope);
            renderEffects(skill, scope);
        });
    }

    function scopeEffects(skill, scope) {
        var primaryTarget = normalizeTarget(skill.targeting);
        var teamTargets = ['allies_all', 'enemies_all', 'both_teams'];
        return (skill.effects || []).filter(function (effect) {
            var applyTo = effect.apply_to || 'target';
            if (scope === 'self') return applyTo === 'self';
            if (scope === 'team') return teamTargets.includes(applyTo) && applyTo !== primaryTarget;
            return applyTo === 'target'
                || (teamTargets.includes(applyTo) && applyTo === primaryTarget)
                || (!teamTargets.includes(applyTo) && applyTo !== 'self');
        });
    }

    function updateTeamEffectsContext(skill) {
        var primaryTarget = normalizeTarget(skill?.targeting || byId('skill-editor').elements.targeting.value);
        var title = 'Alguma equipa sofre um efeito?';
        var help = 'Aplica um efeito à equipa aliada, adversária ou a ambas.';
        if (primaryTarget === 'enemies_all') {
            title = 'A equipa aliada sofre também um efeito?';
            help = 'Todos os inimigos já são o alvo principal; aqui podes afetar os aliados.';
        } else if (primaryTarget === 'allies_all') {
            title = 'A equipa adversária sofre também um efeito?';
            help = 'Todos os aliados já são o alvo principal; aqui podes afetar os inimigos.';
        } else if (primaryTarget === 'both_teams') {
            title = 'As equipas recebem efeitos diferentes?';
            help = 'O alvo principal cobre ambas; usa esta secção para configurar um efeito próprio por lado.';
        }
        byId('team-effects-title').textContent = title;
        byId('team-effects-help').textContent = help;

    }

    function defaultTeamTarget(skill) {
        return availableTeamTargets(skill)[0] || 'allies_all';
    }

    function availableTeamTargets(skill) {
        var primaryTarget = normalizeTarget(skill.targeting);
        if (primaryTarget === 'enemies_all') return ['allies_all'];
        if (primaryTarget === 'allies_all') return ['enemies_all'];
        if (primaryTarget === 'both_teams') return ['allies_all', 'enemies_all'];
        return ['allies_all', 'enemies_all', 'both_teams'];
    }

    function renderPatternButtons(scope) {
        document.querySelector('[data-pattern-buttons="' + scope + '"]').innerHTML = PATTERNS.map(function (pattern) {
            return '<button class="pattern-button" type="button" data-add-effect="' + scope + '" data-pattern="' + pattern[0] + '">' + pattern[1] + '</button>';
        }).join('');
    }

    function renderEffects(skill, scope) {
        var container = byId(scope + '-effects');
        var effects = scopeEffects(skill, scope);
        container.innerHTML = effects.length ? effects.map(function (effect) {
            var pattern = detectPattern(effect);
            var chance = effect.effect_hit_chance ?? effect.apply_chance ?? 1;
            chance = Math.round(Number(chance) <= 1 ? Number(chance) * 100 : Number(chance));
            var applyTo = scope === 'team'
                ? '<label class="effect-field effect-field-wide"><span>Quem é afetado?</span><select class="control" data-effect-field="apply_to">' + targetOptions(effect.apply_to || defaultTeamTarget(skill), skill) + '</select></label>'
                : '';
            return '<article class="effect-card" data-effect-card data-effect-scope="' + escapeHtml(scope) + '" data-effect-id="' + escapeHtml(effect.effect_id) + '">'
                + '<div class="effect-card-head"><div><span class="field-label">EFEITO</span><code>' + escapeHtml(effect.effect_id) + '</code></div><button class="icon-button icon-button-small effect-remove" type="button" data-remove-effect="' + escapeHtml(effect.effect_id) + '" title="Remover efeito">×</button></div>'
                + '<div class="form-grid effect-main-grid">'
                + '<label class="effect-field"><span>Nome</span><input class="control" data-effect-field="status_effect" value="' + escapeHtml(effect.status_effect || '') + '" placeholder="Ex.: Regeneração"></label>'
                + '<label class="effect-field"><span>Operação</span><select class="control" data-effect-pattern>' + PATTERNS.map(function (item) { return optionMarkup(item[0], item[1], item[0] === pattern); }).join('') + '</select></label>'
                + '<label class="effect-field"><span>Elemento</span><select class="control" data-effect-field="element_id">' + optionMarkup('', 'Usar ' + skill.element_id, !effect.element_id) + Model.ELEMENTS.map(function (id) { return optionMarkup(id, id, effect.element_id === id); }).join('') + '</select></label>'
                + '<label class="effect-field"><span>Duração</span><div class="input-suffix"><input class="control" data-effect-field="turns" type="number" min="0" value="' + escapeHtml(Array.isArray(effect.turns) ? effect.turns[1] : effect.turns ?? 1) + '"><span>turnos</span></div></label>'
                + '<label class="effect-field"><span>Precisão</span><div class="input-suffix"><input class="control" data-effect-field="effect_hit_chance" type="number" min="0" max="100" value="' + chance + '"><span>%</span></div></label>'
                + applyTo + renderEffectPatternFields(effect, pattern)
                + '<label class="effect-stack"><input type="checkbox" data-effect-field="can_stack" ' + (effect.can_stack ? 'checked' : '') + '> Pode acumular</label></div>'
                + renderEffectAdvancedFields(effect)
                + '</article>';
        }).join('') : '<p class="no-effects">Escolhe um padrão para adicionar o primeiro efeito.</p>';
    }

    function renderEffectPatternFields(effect, pattern) {
        if (pattern === 'regen') {
            var regen = effect.resource_regen || {};
            return resourceInput('Recuperar vida', 'hp', regen.hp, 'resource_regen')
                + resourceInput('Recuperar mana', 'mana', regen.mana, 'resource_regen')
                + resourceInput('Recuperar stamina', 'stamina', regen.stamina, 'resource_regen')
                + '<label class="effect-field"><span>Cura imediata</span><input class="control" data-effect-field="heal" type="number" min="0" value="' + escapeHtml(effect.heal ?? '') + '" placeholder="0"><small>Paga de uma vez, ao aplicar.</small></label>';
        }
        if (pattern === 'regen_turn') {
            var perTurn = effect.regen_per_turn || {};
            return resourceInput('Vida por turno', 'hp', perTurn.hp, 'regen_per_turn')
                + resourceInput('Mana por turno', 'mana', perTurn.mana, 'regen_per_turn')
                + resourceInput('Stamina por turno', 'stamina', perTurn.stamina, 'regen_per_turn');
        }
        if (pattern === 'buff' || pattern === 'debuff') {
            return statRowsEditor(effect, pattern);
        }
        if (pattern === 'damage') {
            var variance = effect.damage_variance || [1, 1];
            return '<label class="effect-field"><span>Dano por turno</span><input class="control" data-effect-field="damage_per_turn" type="number" min="0" value="' + escapeHtml(effect.damage_per_turn ?? '') + '" placeholder="0"></label>'
                + '<label class="effect-field"><span>Dano imediato</span><input class="control" data-effect-field="damage" type="number" min="0" value="' + escapeHtml(effect.damage ?? '') + '" placeholder="0"></label>'
                + '<label class="effect-field"><span>Variação do dano imediato</span><div class="range-pair"><input class="control" data-effect-variance="min" type="number" min="0" step="0.1" value="' + escapeHtml(variance[0] ?? 1) + '"><input class="control" data-effect-variance="max" type="number" min="0" step="0.1" value="' + escapeHtml(variance[1] ?? 1) + '"></div></label>';
        }
        if (pattern === 'drain') {
            var drain = effect.resource_drain || {};
            var resource = Object.keys(drain)[0] || 'hp';
            return '<label class="effect-field"><span>Recurso drenado</span><select class="control" data-effect-drain-resource><option value="hp" ' + (resource === 'hp' ? 'selected' : '') + '>Vida</option><option value="mana" ' + (resource === 'mana' ? 'selected' : '') + '>Mana</option><option value="stamina" ' + (resource === 'stamina' ? 'selected' : '') + '>Stamina</option></select></label>'
                + '<label class="effect-field"><span>Quantidade</span><input class="control" data-effect-drain-amount type="number" min="0" value="' + escapeHtml(drain[resource] ?? 8) + '"></label>';
        }
        if (pattern === 'transfer') {
            var transfer = effect.resource_transfer || {};
            var transferResource = transfer.resource || 'mana';
            return '<label class="effect-field"><span>Recurso transferido</span><select class="control" data-effect-transfer-resource><option value="hp" ' + (transferResource === 'hp' ? 'selected' : '') + '>Vida</option><option value="mana" ' + (transferResource === 'mana' ? 'selected' : '') + '>Mana</option><option value="stamina" ' + (transferResource === 'stamina' ? 'selected' : '') + '>Stamina</option></select></label>'
                + '<label class="effect-field"><span>Quantidade</span><input class="control" data-effect-transfer-amount type="number" min="1" value="' + escapeHtml(transfer.amount ?? 10) + '"><small>O atacante paga este valor por destinatário; cada um recebe exatamente a mesma quantidade.</small></label>';
        }
        if (pattern === 'cleanse') {
            return '<label class="effect-field"><span>Quantidade</span><input class="control" data-effect-field="cleanse" type="number" min="0" value="' + escapeHtml(effect.cleanse ?? 1) + '"><small>Remove até N estados negativos (os mais antigos primeiro).</small></label>'
                + '<label class="effect-stack"><input type="checkbox" data-effect-field="cleanse_all" ' + (effect.cleanse_all ? 'checked' : '') + '> Remover todos</label>';
        }
        if (pattern === 'dispel') {
            return '<label class="effect-field"><span>Quantidade</span><input class="control" data-effect-field="dispel" type="number" min="0" value="' + escapeHtml(effect.dispel ?? 1) + '"><small>Remove até N estados positivos.</small></label>'
                + '<label class="effect-field"><span>Estado específico</span><input class="control" data-effect-field="dispel_status" value="' + escapeHtml(effect.dispel_status || '') + '" placeholder="darkness_shroud"><small>Remove só este estado, ignorando os restantes.</small></label>'
                + '<label class="effect-stack"><input type="checkbox" data-effect-field="dispel_all" ' + (effect.dispel_all ? 'checked' : '') + '> Remover todos</label>';
        }
        if (pattern === 'regen_max') {
            var perTurnPercent = effect.regen_per_turn_percent || {};
            return resourceInput('Vida % por turno', 'hp', perTurnPercent.hp, 'regen_per_turn_percent')
                + resourceInput('Mana % por turno', 'mana', perTurnPercent.mana, 'regen_per_turn_percent')
                + resourceInput('Stamina % por turno', 'stamina', perTurnPercent.stamina, 'regen_per_turn_percent')
                + '<small>Percentagem do máximo atual do recurso, paga no início de cada turno do alvo.</small>';
        }
        if (pattern === 'cleanse_turn') {
            var perTurnCleanse = effect.cleanse_per_turn || {};
            return '<label class="effect-field"><span>Quantidade por turno</span><input class="control" data-effect-field="cleanse_per_turn.count" type="number" min="1" value="' + escapeHtml(perTurnCleanse.count ?? 1) + '"><small>Remove estados no início de cada turno de quem o carrega.</small></label>'
                + '<label class="effect-field"><span>Polaridade</span><select class="control" data-effect-field="cleanse_per_turn.polarity">'
                + optionMarkup('negative', 'Só estados negativos', (perTurnCleanse.polarity || 'negative') === 'negative')
                + optionMarkup('positive', 'Só estados positivos', perTurnCleanse.polarity === 'positive')
                + optionMarkup('any', 'Qualquer estado', perTurnCleanse.polarity === 'any') + '</select></label>';
        }
        if (pattern === 'heal_max') {
            return '<label class="effect-field"><span>Cura</span><div class="input-suffix"><input class="control" data-effect-field="heal_percent_of_max" type="number" min="0" max="100" value="' + escapeHtml(effect.heal_percent_of_max ?? '') + '" placeholder="0"><span>%</span></div><small>Percentagem da vida máxima atual paga de uma vez.</small></label>';
        }
        if (pattern === 'regen_max_once') {
            var maxOnce = effect.resource_regen_percent_of_max || {};
            return resourceInput('Vida', 'hp', maxOnce.hp, 'resource_regen_percent_of_max')
                + resourceInput('Mana', 'mana', maxOnce.mana, 'resource_regen_percent_of_max')
                + resourceInput('Stamina', 'stamina', maxOnce.stamina, 'resource_regen_percent_of_max')
                + '<small>Cada valor é uma percentagem do máximo atual do resource, paga uma única vez.</small>';
        }
        if (pattern === 'random_regen') {
            return '<label class="effect-field"><span>Recurso aleatório</span><div class="input-suffix"><input class="control" data-effect-field="random_resource_regen.percent" type="number" min="0" max="100" value="' + escapeHtml(asPercent(effect.random_resource_regen)) + '" placeholder="0"><span>%</span></div><small>Sorteia um dos três recursos e restaura esta percentagem do seu máximo.</small></label>'
                + '<label class="effect-field"><span>Recurso aleatório por turno</span><div class="input-suffix"><input class="control" data-effect-field="random_resource_regen_per_turn.percent" type="number" min="0" max="100" value="' + escapeHtml(asPercent(effect.random_resource_regen_per_turn)) + '" placeholder="0"><span>%</span></div><small>O mesmo, feito no início de cada turno do alvo.</small></label>';
        }
        if (pattern === 'spend_trigger') {
            var spend = effect.spend_trigger || {};
            return '<label class="effect-field"><span>Dano por gasto</span><input class="control" data-effect-field="spend_trigger.damage" type="number" min="0" value="' + escapeHtml(spend.damage ?? '') + '" placeholder="0"><small>Sofre este dano sempre que gasta mana ou stamina.</small></label>'
                + '<label class="effect-field"><span>Cura do castor</span><input class="control" data-effect-field="spend_trigger.heal_to_source" type="number" min="0" value="' + escapeHtml(spend.heal_to_source ?? '') + '" placeholder="0"><small>Quem aplicou o estado cura este valor por cada gasto.</small></label>';
        }
        if (pattern === 'modulate') {
            return pairsEditor('Modulação elemental', effect.element_modulation || {}, 'element_modulation_pairs', 'ignis: 0.25, aqua: 2')
                + '<label class="effect-field"><span>Caducidade por elemento</span><input class="control" data-effect-field="expire_on_elements" value="' + escapeHtml(listValue(effect.expire_on_elements)) + '" placeholder="ignis"><small>O estado é levantado quando um ataque deste elemento acerta o portador (lista separada por vírgulas).</small></label>'
                + '<small>Multipliesores que os ataques e efeitos desses elementos sofrem ao atingir o portador (pares \"elemento: múltiplo\").</small>';
        }
        if (pattern === 'shield_effect') {
            var shield = effect.shield || {};
            return '<label class="effect-field"><span>Vida absorvida</span><div class="input-suffix"><input class="control" data-effect-field="shield.percent_of_max_hp" type="number" min="0" max="100" value="' + escapeHtml(shield.percent_of_max_hp ?? '') + '" placeholder="0"><span>%</span></div><small>Fração da vida máxima do portador, recalcada sempre que o estado é aplicado.</small></label>'
                + '<label class="effect-field"><span>Chance de ser atingido</span><div class="input-suffix"><input class="control" data-effect-field="shield.hit_chance" type="number" min="0" max="100" value="' + escapeHtml(percentOf(shield.hit_chance)) + '" placeholder="100"><span>%</span></div><small>Escudo “guardado”: abaixo da chance de acerto, o golpe passa ao próprio portador.</small></label>'
                + '<label class="effect-field"><span>Golpes que aguenta</span><input class="control" data-effect-field="shield.max_hits" type="number" min="0" value="' + escapeHtml(shield.max_hits ?? '') + '" placeholder="—"><small>Limita o número de golpes absorvidos; a última quebra o estado.</small></label>';
        }
        if (pattern === 'charges') {
            var charges = effect.charges || {};
            var release = charges.release || {};
            return '<label class="effect-field"><span>Cargas máximas</span><input class="control" data-effect-field="charges.max" type="number" min="1" value="' + escapeHtml(charges.max ?? 3) + '"><small>Cada acerto com o mesmo estado soma uma carga (os atributos escalam por carga).</small></label>'
                + '<label class="effect-field"><span>Cargas iniciais</span><input class="control" data-effect-field="charges.initial" type="number" min="1" value="' + escapeHtml(charges.initial ?? 1) + '"></label>'
                + '<label class="effect-field"><span>Estado ao esgotar</span><input class="control" data-effect-field="charges.release.status_effect" value="' + escapeHtml(release.status_effect || '') + '" placeholder="Frozen"><small>O que o portador sofre ao chegar às cargas máximas.</small></label>'
                + '<label class="effect-field"><span>Duração do esgotamento</span><input class="control" data-effect-field="charges.release.turns" type="number" min="1" value="' + escapeHtml(release.turns ?? 1) + '"></label>'
                + '<label class="effect-field"><span>Proibido durante o esgotamento</span><input class="control" data-effect-field="charges.release.prevent_actions" value="' + escapeHtml(listValue(release.prevent_actions)) + '" placeholder="attack, defend"><small>Lista de ações separadas por vírgulas (' + Model.PREVENT_ACTIONS.join(', ') + ').</small></label>';
        }
        if (pattern === 'upgrade_status') {
            var upgrade = effect.upgrade_vs_status || {};
            return '<label class="effect-field"><span>Estado de referência</span><input class="control" data-effect-field="upgrade_vs_status.status" value="' + escapeHtml(upgrade.status || '') + '" placeholder="Wet"><small>Aplica estes reforços só quando o alvo já tem este estado.</small></label>'
                + '<label class="effect-field"><span>Turnos extra</span><input class="control" data-effect-field="upgrade_vs_status.extra_turns" type="number" min="0" value="' + escapeHtml(upgrade.extra_turns ?? '') + '" placeholder="0"></label>'
                + '<label class="effect-field"><span>Chance dos turnos extra</span><div class="input-suffix"><input class="control" data-effect-field="upgrade_vs_status.extra_turns_chance" type="number" min="0" max="100" value="' + escapeHtml(percentOf(upgrade.extra_turns_chance)) + '" placeholder="100"><span>%</span></div></label>'
                + '<label class="effect-field"><span>Cura % extra</span><div class="input-suffix"><input class="control" data-effect-field="upgrade_vs_status.extra_heal_percent_of_max" type="number" min="0" max="100" value="' + escapeHtml(upgrade.extra_heal_percent_of_max ?? '') + '" placeholder="0"><span>%</span></div></label>'
                + pairsEditor('Regen % extra', upgrade.extra_regen_per_turn_percent || {}, 'upgrade_regen_pairs', 'hp: 5')
                + '<label class="effect-field"><span>Lava status antes</span><input class="control" data-effect-field="also_remove_status" value="' + escapeHtml(listValue(effect.also_remove_status)) + '" placeholder="Wet"><small>Estados (por rótulo ou ID) removidos quando este aterrissa.</small></label>';
        }
        if (pattern === 'trip') {
            var trip = effect.trip_on_action || {};
            return '<label class="effect-field"><span>Ações que armam</span><input class="control" data-effect-field="trip_on_action.actions" value="' + escapeHtml(listValue(trip.actions)) + '" placeholder="attack, switch_line"><small>Lista de tipos de ação (' + Model.PREVENT_ACTIONS.join(', ') + ').</small></label>'
                + '<label class="effect-field"><span>Só canais de dano</span><input class="control" data-effect-field="trip_on_action.damage_types" value="' + escapeHtml(listValue(trip.damage_types)) + '" placeholder="physical"><small>Vazio arma em qualquer canal (physical/magical).</small></label>'
                + '<label class="effect-field"><span>Chance de deslizar</span><div class="input-suffix"><input class="control" data-effect-field="trip_on_action.chance" type="number" min="0" max="100" value="' + escapeHtml(percentOf(trip.chance)) + '" placeholder="50"><span>%</span></div></label>'
                + '<label class="effect-field"><span>Dano da queda</span><input class="control" data-effect-field="trip_on_action.damage" type="number" min="0" value="' + escapeHtml(trip.damage ?? '') + '" placeholder="0"></label>'
                + '<label class="effect-field"><span>Estado da queda</span><input class="control" data-effect-field="trip_on_action.spawn.status_effect" value="' + escapeHtml((trip.spawn || {}).status_effect || '') + '" placeholder="Slipped"></label>'
                + '<label class="effect-field"><span>Duração do estado</span><input class="control" data-effect-field="trip_on_action.spawn.turns" type="number" min="1" value="' + escapeHtml((trip.spawn || {}).turns ?? 1) + '"></label>'
                + statRowsPicker(trip.spawn || {}, 'trip_on_action.spawn.debuff', 'Debuff da queda')
                + '<label class="effect-field"><span>Máximo de disparos</span><input class="control" data-effect-field="trip_on_action.max_triggers" type="number" min="1" value="' + escapeHtml(trip.max_triggers ?? '') + '" placeholder="—"><small>O campo desaparece depois deste número de ativações.</small></label>'
                + '<label class="effect-field"><span>Dano ao expirar</span><input class="control" data-effect-field="trip_on_action.expire_damage" type="number" min="0" value="' + escapeHtml(trip.expire_damage ?? '') + '" placeholder="0"><small>Se ninguém o disparar, o campo ainda fere quem está nele.</small></label>'
                + '<label class="effect-field"><span>Proibido durante a queda</span><input class="control" data-effect-field="trip_on_action.spawn.prevent_actions" value="' + escapeHtml(listValue((trip.spawn || {}).prevent_actions)) + '" placeholder="attack, skill, weapon"><small>Ações barradas pelo estado gerado (separadas por vírgulas).</small></label>'
                + '<small>A armadilha dura os turnos do estado e desliza quem usa uma das ações listadas.</small>';
        }
        if (pattern === 'detonate') {
            var detonate = effect.detonate_on_turn || {};
            return '<label class="effect-field"><span>Poder da explosão</span><input class="control" data-effect-field="detonate_on_turn.power" type="number" min="0" value="' + escapeHtml(detonate.power ?? 12) + '"><small>Dano fixo quando o turno do portador chega.</small></label>'
                + '<label class="effect-field"><span>Cresce por turno</span><input class="control" data-effect-field="detonate_on_turn.scale_per_turn" type="number" min="0" value="' + escapeHtml(detonate.scale_per_turn ?? '') + '" placeholder="0"></label>'
                + '<label class="effect-field"><span>Teto de poder</span><input class="control" data-effect-field="detonate_on_turn.max_power" type="number" min="0" value="' + escapeHtml(detonate.max_power === Infinity ? '' : (detonate.max_power ?? '')) + '" placeholder="sem teto"></label>'
                + '<label class="effect-stack"><input type="checkbox" data-effect-field="detonate_on_turn.include_line" ' + (detonate.include_line ? 'checked' : '') + '> Atinge a linha inteira</label>'
                + '<label class="effect-field"><span>Chance de perder o turno</span><div class="input-suffix"><input class="control" data-effect-field="detonate_on_turn.turn_skip_chance" type="number" min="0" max="100" value="' + escapeHtml(percentOf(detonate.turn_skip_chance)) + '" placeholder="0"><span>%</span></div></label>';
        }
        if (pattern === 'chain_detonation') {
            var chainDetonation = effect.chain_detonation || {};
            return '<label class="effect-field"><span>Dano extra</span><input class="control" data-effect-field="chain_detonation.power" type="number" min="0" value="' + escapeHtml(chainDetonation.power ?? 8) + '"><small>Pago quando outro golpe de Chaos acerta o portador.</small></label>'
                + '<label class="effect-field"><span>Recuo por marca extra</span><input class="control" data-effect-field="chain_detonation.recoil_per_target" type="number" min="0" value="' + escapeHtml(chainDetonation.recoil_per_target ?? '') + '" placeholder="0"><small>Vida que o atacante paga por cada marca vizinha detonada.</small></label>';
        }
        if (pattern === 'conductor') {
            var conductor = effect.conductor || {};
            return '<label class="effect-field"><span>Salto elétrico</span><input class="control" data-effect-field="conductor.jump_power" type="number" min="0" value="' + escapeHtml(conductor.jump_power ?? 8) + '"><small>Dano fixo que salta para o inimigo mais próximo.</small></label>'
                + '<label class="effect-field"><span>Elementos que aterram</span><input class="control" data-effect-field="conductor.grounded_by_elements" value="' + escapeHtml(listValue(conductor.grounded_by_elements)) + '" placeholder="lapis"><small>Lista separada por vírgulas.</small></label>'
                + '<label class="effect-field"><span>Escudo ao aterrar</span><div class="input-suffix"><input class="control" data-effect-field="conductor.ground_shield_percent" type="number" min="0" max="100" value="' + escapeHtml(conductor.ground_shield_percent ?? '') + '" placeholder="0"><span>%</span></div><small>Percentagem da vida máxima do aliado mais próximo.</small></label>';
        }
        if (pattern === 'interrupt') {
            var interrupt = effect.interrupt || {};
            return '<label class="effect-field"><span>Chance de interromper</span><div class="input-suffix"><input class="control" data-effect-field="interrupt.chance" type="number" min="0" max="100" value="' + escapeHtml(percentOf(interrupt.chance)) + '" placeholder="50"><span>%</span></div><small>A ação falha, mas os custos são pagos.</small></label>'
                + '<label class="effect-field"><span>Ações vigiadas</span><input class="control" data-effect-field="interrupt.actions" value="' + escapeHtml(listValue(interrupt.actions)) + '" placeholder="skill, weapon"><small>Vazio vigia skills e armas.</small></label>';
        }
        if (pattern === 'reflect') {
            var reflect = effect.reflect || {};
            return '<label class="effect-field"><span>Dano refletido</span><input class="control" data-effect-field="reflect.power" type="number" min="0" value="' + escapeHtml(reflect.power ?? 8) + '"></label>'
                + '<label class="effect-field"><span>Chance</span><div class="input-suffix"><input class="control" data-effect-field="reflect.chance" type="number" min="0" max="100" value="' + escapeHtml(percentOf(reflect.chance ?? 1)) + '" placeholder="100"><span>%</span></div></label>'
                + '<label class="effect-stack"><input type="checkbox" data-effect-field="reflect.consume" ' + (reflect.consume ? 'checked' : '') + '> Consome o estado ao refletir</label>';
        }
        if (pattern === 'spend_steal') {
            var steal = effect.spend_steal || {};
            return '<label class="effect-field"><span>Recurso</span><select class="control" data-effect-field="spend_steal.resource">'
                + optionMarkup('mana', 'Mana', (steal.resource || 'mana') === 'mana')
                + optionMarkup('stamina', 'Stamina', steal.resource === 'stamina') + '</select></label>'
                + '<label class="effect-field"><span>Percentagem roubada</span><div class="input-suffix"><input class="control" data-effect-field="spend_steal.percent" type="number" min="0" max="100" value="' + escapeHtml(percentOf(steal.percent)) + '" placeholder="25"><span>%</span></div></label>'
                + '<label class="effect-field"><span>Valor fixo</span><input class="control" data-effect-field="spend_steal.amount" type="number" min="0" value="' + escapeHtml(steal.amount ?? '') + '" placeholder="0"><small>Substitui a percentagem quando preenchido.</small></label>'
                + '<label class="effect-field"><span>Teto por gasto</span><input class="control" data-effect-field="spend_steal.max" type="number" min="0" value="' + escapeHtml(steal.max ?? '') + '" placeholder="—"></label>';
        }
        if (pattern === 'evade_next') {
            var evade = effect.evade_next || {};
            return '<label class="effect-field"><span>Canais esquivados</span><input class="control" data-effect-field="evade_next.damage_types" value="' + escapeHtml(listValue(evade.damage_types)) + '" placeholder="physical"><small>Lista separada por vírgulas; vazio esquiva qualquer canal.</small></label>'
                + '<label class="effect-field"><span>Dano da riposta</span><input class="control" data-effect-field="evade_next.power" type="number" min="0" value="' + escapeHtml(evade.power ?? '') + '" placeholder="10"></label>'
                + '<label class="effect-field"><span>Chance</span><div class="input-suffix"><input class="control" data-effect-field="evade_next.chance" type="number" min="0" max="100" value="' + escapeHtml(percentOf(evade.chance ?? 1)) + '" placeholder="100"><span>%</span></div></label>';
        }
        if (pattern === 'damage_redirect') {
            var redirect = effect.damage_redirect || {};
            return '<label class="effect-field"><span>Quem protege</span><select class="control" data-effect-field="damage_redirect.scope">'
                + optionMarkup('allies_all', 'Todos os aliados', (redirect.scope || 'allies_all') === 'allies_all')
                + optionMarkup('allies_lane', 'Só a linha do portador', redirect.scope === 'allies_lane') + '</select></label>'
                + '<small>O dano destinado aos aliados protegidos é desviado para o portador.</small>';
        }
        if (pattern === 'cost_multiplier') {
            var costMultiplier = effect.cost_multiplier || {};
            return '<label class="effect-field"><span>Multiplicador de mana</span><div class="input-suffix"><input class="control" data-effect-field="cost_multiplier.mana" type="number" min="0" max="1" step="0.05" value="' + escapeHtml(costMultiplier.mana ?? 1) + '"><span>×</span></div></label>'
                + '<label class="effect-field"><span>Multiplicador de stamina</span><div class="input-suffix"><input class="control" data-effect-field="cost_multiplier.stamina" type="number" min="0" max="1" step="0.05" value="' + escapeHtml(costMultiplier.stamina ?? 1) + '"><span>×</span></div><small>Os custos são arredondados para cima.</small></label>';
        }
        if (pattern === 'end_cost') {
            var endCost = effect.end_cost || {};
            return '<label class="effect-field"><span>Recurso</span><select class="control" data-effect-field="end_cost.resource">'
                + optionMarkup('stamina', 'Stamina', (endCost.resource || 'stamina') === 'stamina')
                + optionMarkup('mana', 'Mana', endCost.resource === 'mana') + '</select></label>'
                + '<label class="effect-field"><span>Percentagem do máximo</span><div class="input-suffix"><input class="control" data-effect-field="end_cost.percent_of_max" type="number" min="0" max="100" value="' + escapeHtml(endCost.percent_of_max ?? '') + '" placeholder="50"><span>%</span></div><small>O que faltar no recurso é pago em vida.</small></label>';
        }
        if (pattern === 'on_death_blast') {
            var deathBlast = effect.on_death_blast || {};
            return '<label class="effect-field"><span>Poder da explosão</span><input class="control" data-effect-field="on_death_blast.power" type="number" min="0" value="' + escapeHtml(deathBlast.power ?? 40) + '"><small>Dano físico fixo a quem desferiu o golpe direto que derrubou o portador.</small></label>';
        }
        if (pattern === 'stack_dot') {
            var stackDot = effect.stacking || {};
            return '<label class="effect-field"><span>Dano por stack</span><input class="control" data-effect-field="damage_per_turn" type="number" min="0" value="' + escapeHtml(effect.damage_per_turn ?? 4) + '"></label>'
                + '<label class="effect-field"><span>Momento do dano</span><select class="control" data-effect-field="damage_timing">'
                + optionMarkup('turn_end', 'Fim do turno', (effect.damage_timing || 'turn_end') === 'turn_end')
                + optionMarkup('turn_start', 'Início do turno', effect.damage_timing === 'turn_start') + '</select></label>'
                + '<label class="effect-field"><span>Stacks iniciais</span><input class="control" data-effect-field="stacking.initial" type="number" min="1" value="' + escapeHtml(stackDot.initial ?? 1) + '"></label>'
                + '<label class="effect-field"><span>Turnos extra ao reaplicar</span><input class="control" data-effect-field="stacking.extend_turns" type="number" min="0" value="' + escapeHtml(stackDot.extend_turns ?? 1) + '"></label>'
                + '<label class="effect-field"><span>Stacks perdidos por turno</span><input class="control" data-effect-field="decay_per_turn" type="number" min="0" value="' + escapeHtml(effect.decay_per_turn ?? 0) + '"></label>'
                + '<label class="effect-field"><span>Elementos que apagam</span><input class="control" data-effect-field="expire_on_elements" value="' + escapeHtml(listValue(effect.expire_on_elements)) + '" placeholder="aqua, caeli"></label>';
        }
        if (pattern === 'burst_stacks') {
            var burst = effect.burst || {};
            return '<label class="effect-field"><span>Stacks no fim do turno</span><input class="control" data-effect-field="turn_end_stacks" type="number" min="0" value="' + escapeHtml(effect.turn_end_stacks ?? 1) + '"></label>'
                + '<label class="effect-field"><span>Limiar de explosão</span><input class="control" data-effect-field="burst_at" type="number" min="2" value="' + escapeHtml(effect.burst_at ?? 4) + '"></label>'
                + '<label class="effect-field"><span>Dano da explosão</span><input class="control" data-effect-field="burst.damage" type="number" min="0" value="' + escapeHtml(burst.damage ?? 10) + '"></label>'
                + '<label class="effect-field"><span>Custo extra por stack</span><input class="control" data-effect-field="per_stack_cost" type="number" min="0" step="0.01" value="' + escapeHtml(effect.per_stack_cost ?? 0.05) + '"></label>'
                + '<label class="effect-field"><span>Regen perdida por stack</span><input class="control" data-effect-field="per_stack_regen_reduction" type="number" min="0" step="0.01" value="' + escapeHtml(effect.per_stack_regen_reduction ?? 0.1) + '"></label>'
                + '<label class="effect-field"><span>Lavagem por elemento</span></label>'
                + pairsEditor('Lavagem por elemento', effect.wash_on_elements || {}, 'wash_on_elements_pairs', 'aqua: 1, caeli: 1');
        }
        if (pattern === 'fire_wall') {
            var wall = effect.fire_wall || {};
            return '<label class="effect-field"><span>Dano de armas à distância</span><div class="input-suffix"><input class="control" data-effect-field="fire_wall.ranged_weapon" type="number" min="0" max="1" step="0.05" value="' + escapeHtml(wall.ranged_weapon ?? 0.7) + '"><span>×</span></div></label>'
                + '<label class="effect-field"><span>Dano de projéteis</span><div class="input-suffix"><input class="control" data-effect-field="fire_wall.projectile" type="number" min="0" max="1" step="0.05" value="' + escapeHtml(wall.projectile ?? 0.7) + '"><span>×</span></div></label>'
                + '<label class="effect-field"><span>Dano físico</span><div class="input-suffix"><input class="control" data-effect-field="fire_wall.physical" type="number" min="0" max="1" step="0.05" value="' + escapeHtml(wall.physical ?? 1) + '"><span>×</span></div></label>'
                + '<label class="effect-field"><span>Elementos que erodem</span><input class="control" data-effect-field="fire_wall.erode_elements" value="' + escapeHtml(listValue(wall.erode_elements)) + '" placeholder="aqua, caeli"></label>'
                + '<label class="effect-stack"><input type="checkbox" data-effect-field="fire_wall.no_erode" ' + (wall.no_erode ? 'checked' : '') + '> Não pode ser encurtado</label>';
        }
        if (pattern === 'element_damage') {
            return pairsEditor('Dano elemental', effect.element_damage || {}, 'element_damage_pairs', 'ignis: 1.15');
        }
        if (pattern === 'projectile_element') {
            return '<label class="effect-field"><span>Projéteis contam como</span><input class="control" data-effect-field="projectile_element" value="' + escapeHtml(effect.projectile_element || '') + '" placeholder="ignis"></label>';
        }
        if (pattern === 'ignite_attacker') {
            var igniter = effect.ignite_attacker_on_hit || {};
            return '<label class="effect-field"><span>Canais que queimam</span><input class="control" data-effect-field="ignite_attacker_on_hit.damage_types" value="' + escapeHtml(listValue(igniter.damage_types)) + '" placeholder="physical"></label>'
                + '<label class="effect-field"><span>Chance</span><div class="input-suffix"><input class="control" data-effect-field="ignite_attacker_on_hit.chance" type="number" min="0" max="100" value="' + escapeHtml(percentOf(igniter.chance)) + '" placeholder="40"><span>%</span></div></label>'
                + '<label class="effect-field"><span>Stacks de Burn</span><input class="control" data-effect-field="ignite_attacker_on_hit.burn_stacks" type="number" min="0" value="' + escapeHtml(igniter.burn_stacks ?? 1) + '"></label>';
        }
        if (pattern === 'turn_end_burn') {
            var endBurn = effect.turn_end_burn || {};
            return '<label class="effect-field"><span>Chance</span><div class="input-suffix"><input class="control" data-effect-field="turn_end_burn.chance" type="number" min="0" max="100" value="' + escapeHtml(percentOf(endBurn.chance)) + '" placeholder="20"><span>%</span></div></label>'
                + '<label class="effect-field"><span>Stacks de Burn</span><input class="control" data-effect-field="turn_end_burn.burn_stacks" type="number" min="0" value="' + escapeHtml(endBurn.burn_stacks ?? 1) + '"></label>'
                + '<label class="effect-field"><span>Duração do Burn</span><input class="control" data-effect-field="turn_end_burn.burn_turns" type="number" min="0" value="' + escapeHtml(endBurn.burn_turns ?? 2) + '"></label>';
        }
        if (pattern === 'cleanse_dot') {
            return '<label class="effect-field"><span>Remover DoTs</span><input class="control" data-effect-field="cleanse_dot" type="number" min="1" value="' + escapeHtml(effect.cleanse_dot ?? 1) + '"><small>Remove apenas efeitos de dano contínuo.</small></label>';
        }
        if (pattern === 'regen_bonus') {
            return '<label class="effect-field"><span>Bónus por estado negativo</span><div class="input-suffix"><input class="control" data-effect-field="regen_bonus_per_negative" type="number" min="0" value="' + escapeHtml(effect.regen_bonus_per_negative ?? '') + '" placeholder="2"><span>%</span></div></label>'
                + '<label class="effect-field"><span>Bónus por 10% de DoT</span><div class="input-suffix"><input class="control" data-effect-field="regen_bonus_per_dot_percent" type="number" min="0" value="' + escapeHtml(effect.regen_bonus_per_dot_percent ?? '') + '" placeholder="4"><span>%</span></div></label>';
        }
        if (pattern === 'regen_lowest') {
            return '<label class="effect-field"><span>Recurso mais baixo</span><div class="input-suffix"><input class="control" data-effect-field="regen_lowest_percent" type="number" min="0" max="100" value="' + escapeHtml(effect.regen_lowest_percent ?? '') + '" placeholder="6"><span>%</span></div><small>Restaura a percentagem do máximo de MN ou SN, o que estiver mais baixo.</small></label>';
        }
        if (pattern === 'refund_spent') {
            var refund = effect.refund_spent || {};
            return '<label class="effect-field"><span>Percentagem devolvida</span><div class="input-suffix"><input class="control" data-effect-field="refund_spent.percent" type="number" min="0" max="100" value="' + escapeHtml(percentOf(refund.percent)) + '" placeholder="25"><span>%</span></div><small>Devolve parte do MN/SN gasto enquanto o estado durou.</small></label>'
                + '<label class="effect-field"><span>Recursos</span><input class="control" data-effect-field="refund_spent.resources" value="' + escapeHtml(listValue(refund.resources)) + '" placeholder="mana, stamina"></label>';
        }
        if (pattern === 'cleanse_on_heal') {
            var cleanseOnHeal = effect.cleanse_on_heal || {};
            return '<label class="effect-field"><span>Limpar ao receber cura</span><input class="control" data-effect-field="cleanse_on_heal.count" type="number" min="1" value="' + escapeHtml(cleanseOnHeal.count ?? 1) + '"></label>'
                + '<label class="effect-field"><span>Elemento da cura</span><input class="control" data-effect-field="cleanse_on_heal.element" value="' + escapeHtml(cleanseOnHeal.element || 'florere') + '"></label>'
                + '<label class="effect-field"><span>Máximo de limpezas</span><input class="control" data-effect-field="cleanse_on_heal.max_triggers" type="number" min="1" value="' + escapeHtml(cleanseOnHeal.max_triggers ?? 3) + '"></label>';
        }
        if (pattern === 'damage_reduction') {
            var reduction = effect.damage_reduction || {};
            return '<label class="effect-field"><span>Redução</span><div class="input-suffix"><input class="control" data-effect-field="damage_reduction.percent" type="number" min="0" max="100" value="' + escapeHtml(percentOf(reduction.percent)) + '" placeholder="15"><span>%</span></div></label>'
                + '<label class="effect-field"><span>Cargas</span><input class="control" data-effect-field="damage_reduction.charges" type="number" min="1" value="' + escapeHtml(reduction.charges ?? 1) + '"></label>'
                + '<label class="effect-field"><span>Cura adjacente</span><div class="input-suffix"><input class="control" data-effect-field="damage_reduction.heal_adjacent_percent" type="number" min="0" max="100" value="' + escapeHtml(reduction.heal_adjacent_percent ?? '') + '" placeholder="6"><span>%</span></div></label>';
        }
        if (pattern === 'drain_max') {
            var drainMax = effect.drain_percent_of_max_hp || {};
            return '<label class="effect-field"><span>Recurso</span><select class="control" data-effect-field="drain_percent_of_max_hp.resource">'
                + optionMarkup('hp', 'Vida', (drainMax.resource || 'hp') === 'hp')
                + optionMarkup('mana', 'Mana', drainMax.resource === 'mana') + '</select></label>'
                + '<label class="effect-field"><span>Percentagem do máximo</span><div class="input-suffix"><input class="control" data-effect-field="drain_percent_of_max_hp.percent" type="number" min="0" max="100" value="' + escapeHtml(drainMax.percent ?? '') + '" placeholder="8"><span>%</span></div></label>';
        }
        if (pattern === 'drain_turn') {
            var drainTurn = effect.drain_per_turn || {};
            return '<label class="effect-field"><span>Recurso</span><select class="control" data-effect-field="drain_per_turn.resource">'
                + optionMarkup('hp', 'Vida', (drainTurn.resource || 'hp') === 'hp')
                + optionMarkup('mana', 'Mana', drainTurn.resource === 'mana') + '</select></label>'
                + '<label class="effect-field"><span>Percentagem por turno</span><div class="input-suffix"><input class="control" data-effect-field="drain_per_turn.percent_of_max" type="number" min="0" max="100" value="' + escapeHtml(drainTurn.percent_of_max ?? '') + '" placeholder="6"><span>%</span></div></label>'
                + '<label class="effect-field"><span>Chance</span><div class="input-suffix"><input class="control" data-effect-field="drain_per_turn.chance" type="number" min="0" max="100" value="' + escapeHtml(percentOf(drainTurn.chance ?? 1)) + '"><span>%</span></div></label>'
                + '<label class="effect-stack"><input type="checkbox" data-effect-field="drain_per_turn.heal_to_source" ' + (drainTurn.heal_to_source ? 'checked' : '') + '> Devolve ao lançador</label>';
        }
        if (pattern === 'movement_immune') {
            return '<label class="effect-stack"><input type="checkbox" data-effect-field="movement_immunity" ' + (effect.movement_immunity ? 'checked' : '') + '> Não pode ser movido por efeitos</label>';
        }
        if (pattern === 'stat_multipliers') {
            return pairsEditor('Multiplicadores de atributos', effect.stat_multipliers || {}, 'stat_multiplier_pairs', 'physical_attack: 1.15, magical_attack: 1.15')
                + '<small>Valores multiplicativos (1.15 = +15%).</small>';
        }
        if (pattern === 'deferred') {
            var deferred = effect.deferred_damage || {};
            return '<label class="effect-field"><span>Dano</span><input class="control" data-effect-field="deferred_damage.amount" type="number" min="0" value="' + escapeHtml(deferred.amount ?? 12) + '"><small>O golpe cai mais tarde, não agora.</small></label>'
                + '<label class="effect-field"><span>Daqui a quantos turnos</span><input class="control" data-effect-field="deferred_damage.after_turns" type="number" min="1" value="' + escapeHtml(deferred.after_turns ?? 2) + '"></label>';
        }
        if (pattern === 'echo') {
            var echo = effect.echo || {};
            return '<label class="effect-field"><span>Multiplicador</span><input class="control" data-effect-field="echo.multiplier" type="number" min="0" step="0.1" value="' + escapeHtml(echo.multiplier ?? 1) + '"><small>Repete a última ação de quem usa a skill, com este multiplicador.</small></label>';
        }
        if (pattern === 'move') {
            var move = effect.move || {};
            return '<label class="effect-field"><span>Quem se move</span><select class="control" data-effect-field="move.who">'
                + optionMarkup('target', 'O alvo', move.who === 'target')
                + optionMarkup('self', 'Quem usa a skill', move.who === 'self') + '</select></label>'
                + '<label class="effect-field"><span>Para a linha</span><select class="control" data-effect-field="move.to_line">'
                + optionMarkup('front', 'Frente', move.to_line === 'front')
                + optionMarkup('rear', 'Trás', move.to_line === 'rear')
                + optionMarkup('other', 'Para a outra linha', move.to_line === 'other') + '</select></label>'
                + '<label class="effect-stack"><input type="checkbox" data-effect-field="move.swap_with_caster" ' + (move.swap_with_caster ? 'checked' : '') + '> Trocar de posição</label>';
        }
        if (pattern === 'stall') {
            var postpone = effect.turn_postpone || {};
            var postponeCondition = postpone.condition || {};
            return '<label class="effect-field"><span>Espaços de atraso</span><input class="control" data-effect-field="turn_postpone.slots" type="number" min="1" value="' + escapeHtml(postpone.slots ?? 1) + '"><small>Adia o próximo turno pendente do alvo na ronda atual.</small></label>'
                + '<label class="effect-field"><span>Vantagem de velocidade</span><input class="control" data-effect-field="turn_postpone.per_speed_advantage" type="number" min="1" value="' + escapeHtml(postpone.per_speed_advantage ?? '') + '" placeholder="—"><small>Por cada N pontos em que quem usa a skill é mais rápido, atrasa mais um espaço.</small></label>'
                + '<label class="effect-stack"><input type="checkbox" data-effect-field="turn_postpone.condition.requires_pending" ' + (postponeCondition.requires_pending ? 'checked' : '') + '> Só se o alvo ainda não agiu</label>';
        }
        if (pattern === 'react_move') {
            var reaction = effect.on_miss_move || {};
            return '<label class="effect-field"><span>Quem se move</span><select class="control" data-effect-field="on_miss_move.who">'
                + optionMarkup('self', 'O portador do estado', (reaction.who || 'self') === 'self')
                + optionMarkup('target', 'O atacante', reaction.who === 'target') + '</select></label>'
                + '<label class="effect-field"><span>Para a linha</span><select class="control" data-effect-field="on_miss_move.to_line">'
                + optionMarkup('front', 'Frente', reaction.to_line === 'front')
                + optionMarkup('rear', 'Trás', reaction.to_line === 'rear')
                + optionMarkup('other', 'Para a outra linha', (reaction.to_line || 'other') === 'other') + '</select></label>'
                + '<label class="effect-stack"><input type="checkbox" data-effect-field="on_miss_move.swap_with_caster" ' + (reaction.swap_with_caster ? 'checked' : '') + '> Trocar de posição</label>'
                + '<label class="effect-stack"><input type="checkbox" data-effect-field="on_miss_move.break_after" ' + (reaction.break_after !== false ? 'checked' : '') + '> O estado acaba depois de mover</label>';
        }
        if (pattern === 'weather') {
            var weather = effect.weather || {};
            return '<label class="effect-field"><span>Rondas de clima</span><input class="control" data-effect-field="weather.rounds" type="number" min="0" value="' + escapeHtml(weather.rounds ?? 3) + '"><small>O clima cobre todo o campo e cai no fim da ronda.</small></label>'
                + '<label class="effect-field"><span>Dano aos adversários</span><input class="control" data-effect-field="weather.chip_damage" type="number" min="0" value="' + escapeHtml(weather.chip_damage ?? '') + '" placeholder="0"><small>Dano fixo por ronda a quem se opõe ao lado que instalou o clima.</small></label>'
                + pairsEditor('Efeitos por elemento', weather.element_effect_multipliers || {}, 'weather_element_pairs', 'aqua: 1.1, ignis: 0.9')
                + '<small>Dano e efeitos desses elementos multiplicam-se enquanto o clima durar.</small>';
        }
        if (pattern === 'sight') {
            var sight = effect.projectile_accuracy || {};
            return '<label class="effect-field"><span>Ganho de precisão</span><input class="control" data-effect-field="projectile_accuracy.amount" type="number" min="0" value="' + escapeHtml(sight.amount ?? 12) + '"><small>Aplica-se a armas lançadas e armas de longo alcance.</small></label>'
                + '<label class="effect-field"><span>Contra a linha</span><select class="control" data-effect-field="projectile_accuracy.vs_lane">'
                + optionMarkup('', 'Qualquer linha', !sight.vs_lane)
                + optionMarkup('front', 'Só a linha da frente', sight.vs_lane === 'front')
                + optionMarkup('rear', 'Só a linha de trás', sight.vs_lane === 'rear') + '</select></label>';
        }
        if (pattern === 'mark') {
            var mark = effect.projectile_mark || {};
            return '<label class="effect-field"><span>Precisão contra o portador</span><input class="control" data-effect-field="projectile_mark.accuracy" type="number" min="0" value="' + escapeHtml(mark.accuracy ?? 15) + '"><small>Lançamentos e tiros de longo alcance contra quem traz a marca ganham este bónus.</small></label>';
        }
        if (pattern === 'veil') {
            return '<label class="effect-field"><span>Esquiva contra projéteis</span><input class="control" data-effect-field="ranged_evasion" type="number" min="0" value="' + escapeHtml(effect.ranged_evasion ?? 15) + '"><small>Torna mais difícil acertar o portador com armas lançadas, tiros longos e feitiços.</small></label>';
        }
        if (pattern === 'reroll') {
            var reroll = effect.projectile_reroll || {};
            return '<label class="effect-field"><span>Repetições por ronda</span><input class="control" data-effect-field="projectile_reroll.per_turn" type="number" min="1" max="3" value="' + escapeHtml(reroll.per_turn ?? 1) + '"><small>Repõe no início da ronda seguinte; só funciona em ações de um golpe e sem dispersão.</small></label>';
        }
        if (pattern === 'upkeep') {
            var upkeep = effect.self_upkeep || {};
            return '<label class="effect-field"><span>Vida por turno</span><input class="control" data-effect-field="self_upkeep.hp" type="number" min="0" value="' + escapeHtml(upkeep.hp ?? '') + '" placeholder="0"></label>'
                + '<label class="effect-field"><span>Mana por turno</span><input class="control" data-effect-field="self_upkeep.mana" type="number" min="0" value="' + escapeHtml(upkeep.mana ?? '') + '" placeholder="0"></label>'
                + '<label class="effect-field"><span>Stamina por turno</span><input class="control" data-effect-field="self_upkeep.stamina" type="number" min="0" value="' + escapeHtml(upkeep.stamina ?? '') + '" placeholder="0"><small>O preço da manutenção não cresce com o nível da skill.</small></label>';
        }
        if (pattern === 'rewind') {
            var rewind = effect.rewind || {};
            var rewindResources = Array.isArray(rewind.resources) ? rewind.resources : [];
            return '<label class="effect-field"><span>Quantos turnos</span><input class="control" data-effect-field="rewind.turns" type="number" min="0" value="' + escapeHtml(rewind.turns ?? 1) + '"><small>0 volta até ao início da luta; 1 desfaz o último turno.</small></label>'
                + '<label class="effect-stack"><input type="checkbox" data-effect-field="rewind.resources.hp" ' + (rewindResources.indexOf('hp') !== -1 ? 'checked' : '') + '> Recuperar vida</label>'
                + '<label class="effect-stack"><input type="checkbox" data-effect-field="rewind.resources.mana" ' + (rewindResources.indexOf('mana') !== -1 ? 'checked' : '') + '> Recuperar mana</label>'
                + '<label class="effect-stack"><input type="checkbox" data-effect-field="rewind.resources.stamina" ' + (rewindResources.indexOf('stamina') !== -1 ? 'checked' : '') + '> Recuperar stamina</label>'
                + '<label class="effect-stack"><input type="checkbox" data-effect-field="rewind.cleanse" ' + (rewind.cleanse !== false ? 'checked' : '') + '> Remover os estados</label>';
        }
        return '';
    }

    /** Editor de atributos (buff/debuff) com uma linha por atributo. */
    function statRowsEditor(effect, key) {
        var stats = effect[key] || {};
        var rows = Object.keys(stats).map(function (name) {
            return '<div class="stat-row" data-stat-row>'
                + '<select class="control control-small" data-stat-name>' + Model.STAT_NAMES.map(function (id) {
                    return optionMarkup(id, Model.STAT_LABELS[id] || id, id === name);
                }).join('') + '</select>'
                + '<input class="control control-small" data-stat-value type="number" step="1" value="' + escapeHtml(stats[name]) + '">'
                + '<button class="icon-button icon-button-small" type="button" data-remove-stat title="Remover atributo">×</button>'
                + '</div>';
        }).join('');
        return '<div class="effect-field effect-field-wide" data-effect-stats="' + key + '">'
            + '<span>Atributos e valores</span>'
            + (rows || '<p class="no-effects">Sem atributos — usa “+ Atributo”.</p>')
            + '<button class="button button-small button-quiet" type="button" data-add-stat>+ Atributo</button>'
            + '<small>Positivo aumenta, negativo reduz. <code>accuracy</code> afeta os ataques de quem o recebe.</small>'
            + '</div>';
    }

    /** Opções que só interessam em casos específicos. */
    function renderEffectAdvancedFields(effect) {
        var polarityOptions = [optionMarkup('', 'Automática', !effect.polarity)]
            .concat(Model.POLARITIES.map(function (id) { return optionMarkup(id, id, effect.polarity === id); }))
            .join('');
        var immunities = Array.isArray(effect.status_immunities) ? effect.status_immunities.join(', ') : '';
        var prevented = Array.isArray(effect.prevent_actions) ? effect.prevent_actions.join(', ') : '';
        var deferredCost = effect.deferred_cost || {};
        var randomDebuff = effect.random_debuff && typeof effect.random_debuff === 'object' ? effect.random_debuff : {};
        var randomBuff = effect.random_buff && typeof effect.random_buff === 'object' ? effect.random_buff : {};
        var randomTargets = effect.random_targets && typeof effect.random_targets === 'object' ? effect.random_targets : {};
        var randomDebuffStats = Array.isArray(randomDebuff.stats) ? randomDebuff.stats.join(', ') : '';
        var randomBuffStats = Array.isArray(randomBuff.stats) ? randomBuff.stats.join(', ') : '';
        var damageImmunities = Array.isArray(effect.damage_immunities) ? effect.damage_immunities : [];
        return '<details class="effect-advanced"><summary>Opções avançadas</summary>'
            + '<div class="effect-advanced-group">'
            + '<span class="effect-group-title">Controlo de turno</span>'
            + '<div class="form-grid effect-main-grid">'
            + '<label class="effect-field"><span>Deslocar a ordem de turno</span><input class="control" data-effect-field="turn_offset" type="number" step="1" value="' + escapeHtml(effect.turn_offset ?? '') + '" placeholder="0"><small>Positivo adianta o turno, negativo atrasa-o.</small></label>'
            + '<label class="effect-field"><span>Reduzir cooldowns</span><input class="control" data-effect-field="cooldown_tick" type="number" min="0" value="' + escapeHtml(effect.cooldown_tick ?? '') + '" placeholder="0"><small>Quantos turnos de cooldown tira ao alvo.</small></label>'
            + '<label class="effect-stack"><input type="checkbox" data-effect-field="untargetable" ' + (effect.untargetable ? 'checked' : '') + '> O alvo não pode ser escolhido</label>'
            + '</div></div>'
            + '<div class="effect-advanced-group">'
            + '<span class="effect-group-title">Alvo e defesa</span>'
            + '<div class="form-grid effect-main-grid">'
            + '<label class="effect-field"><span>Imunidade a status</span><input class="control" data-effect-field="status_immunities" value="' + escapeHtml(immunities) + '" placeholder="blinded, stunned"><small>IDs de status que o alvo não pode sofrer.</small></label>'
            + '<label class="effect-field"><span>Ações proibidas</span><input class="control" data-effect-field="prevent_actions" value="' + escapeHtml(prevented) + '" placeholder="attack"><small>' + Model.PREVENT_ACTIONS.join(', ') + '</small></label>'
            + '<label class="effect-stack"><input type="checkbox" data-effect-field="prevent_skills" ' + (effect.prevent_skills ? 'checked' : '') + '> O alvo não pode usar skills</label>'
            + '<label class="effect-stack"><input type="checkbox" data-effect-field="heal_block" ' + (effect.heal_block ? 'checked' : '') + '> O alvo não pode ser curado por outros</label>'
            + '<label class="effect-stack"><input type="checkbox" data-effect-field="counter" ' + (effect.counter ? 'checked' : '') + '> Reflete o próximo golpe recebido</label>'
            + '<label class="effect-field" data-effect-conditional="counter_chance"' + (effect.counter || effect.counter_chance !== undefined ? '' : ' hidden') + '><span>Chance de reflexão</span><div class="input-suffix"><input class="control" data-effect-field="counter_chance" type="number" min="0" max="100" step="5" value="' + escapeHtml(percentOf(effect.counter_chance)) + '" placeholder="100"><span>%</span></div><small>Abaixo da chance o golpe não é refletido (e o estado sobrevive).</small></label>'
            + '<label class="effect-field"><span>Reflexão salvo elementos</span><input class="control" data-effect-field="counter_except_elements" value="' + escapeHtml(listValue(effect.counter_except_elements)) + '" placeholder="ignis"><small>Ataques destes elementos nunca refletem (lista separada por vírgulas).</small></label>'
            + '<label class="effect-stack"><input type="checkbox" data-effect-field="refresh_status" ' + (effect.refresh_status ? 'checked' : '') + '> Atualiza estados com o mesmo rótulo</label>'
            + '<label class="effect-field"><span>Ações que exigem todos os golpes</span><input type="checkbox" data-effect-field="require_all_hits" ' + (effect.require_all_hits ? 'checked' : '') + '> <span>Só quando todos os golpes acertam</span></label>'
            + '<label class="effect-field"><span>Proíbe canais de dano</span><input class="control" data-effect-field="prevent_damage_channels" value="' + escapeHtml(listValue(effect.prevent_damage_channels)) + '" placeholder="physical"><small>O portador não pode usar ataques desses canais (physical/magical).</small></label>'
            + '<label class="effect-field"><span>Bloqueia buffs aos atributos</span><input class="control" data-effect-field="block_stat_buffs" value="' + escapeHtml(listValue(effect.block_stat_buffs)) + '" placeholder="speed"><small>Os buffs do portador a estes atributos são ignorados (' + Model.STAT_NAMES.join(', ') + ').</small></label>'
            + pairsEditor('Modulação de canal de dano', effect.damage_channel_modulation || {}, 'damage_channel_modulation_pairs', 'physical: 0.5')
            + '</div></div>'
            + '<div class="effect-advanced-group">'
            + '<span class="effect-group-title">Mecânica do motor</span>'
            + '<div class="form-grid effect-main-grid">'
            + '<label class="effect-field"><span>Drena parte do dano</span><div class="input-suffix"><input class="control" data-effect-field="drain_percent_of_damage" type="number" min="0" max="100" step="5" value="' + escapeHtml(effect.drain_percent_of_damage === undefined || effect.drain_percent_of_damage === null ? '' : Math.round(Number(effect.drain_percent_of_damage) * 100)) + '" placeholder="0"><span>%</span></div><small>O dano causado cura quem usa a skill nesta fração.</small></label>'
            + '<label class="effect-stack"><input type="checkbox" data-effect-field="confuse" ' + (effect.confuse ? 'checked' : '') + '> Confunde o alvo</label>'
            + '<label class="effect-field" data-effect-conditional="confusion_chance"' + (effect.confuse ? '' : ' hidden') + '><span>Chance de confusão</span><div class="input-suffix"><input class="control" data-effect-field="confusion_chance" type="number" min="0" max="100" step="5" value="' + escapeHtml(effect.confusion_chance === undefined || effect.confusion_chance === null ? 50 : Math.round(Number(effect.confusion_chance) * 100)) + '"><span>%</span></div></label>'
            + '<label class="effect-field"><span>Força a fase</span><select class="control" data-effect-field="set_phase">'
            + optionMarkup('', 'Nenhuma', !effect.set_phase)
            + optionMarkup('day', 'Dia', effect.set_phase === 'day')
            + optionMarkup('night', 'Noite', effect.set_phase === 'night')
            + '</select></label>'
            + '<label class="effect-field" data-effect-conditional="phase_rounds"' + (effect.set_phase ? '' : ' hidden') + '><span>Duração da fase</span><div class="input-suffix"><input class="control" data-effect-field="phase_rounds" type="number" min="1" step="1" value="' + escapeHtml(effect.phase_rounds ?? 5) + '"><span>rondas</span></div></label>'
            + '<label class="effect-stack"><input type="checkbox" data-effect-field="removable_by_lux" ' + (effect.removable_by_lux ? 'checked' : '') + '> Levantado por ataques de Lux</label>'
            + '<label class="effect-stack"><input type="checkbox" data-effect-field="locks_target" ' + (effect.locks_target ? 'checked' : '') + '> Quem usa não pode trocar de alvo</label>'
            + '<label class="effect-stack"><input type="checkbox" data-effect-field="invert_buffs" ' + (effect.invert_buffs ? 'checked' : '') + '> Inverte os buffs do alvo</label>'
            + '<label class="effect-field"><span>Cura por morte</span><input class="control" data-effect-field="heal_on_kill" type="number" min="0" value="' + escapeHtml(effect.heal_on_kill ?? '') + '" placeholder="0"><small>Cura fixa ao portador por cada morte no campo.</small></label>'
            + '<label class="effect-field"><span>Cura por morte (% de vida)</span><div class="input-suffix"><input class="control" data-effect-field="heal_on_kill_percent" type="number" min="0" max="100" step="5" value="' + escapeHtml(effect.heal_on_kill_percent === undefined || effect.heal_on_kill_percent === null ? '' : Math.round(Number(effect.heal_on_kill_percent) * 100)) + '" placeholder="0"><span>%</span></div></label>'
            + '<label class="effect-field"><span>Debuff aleatório: quantos</span><input class="control" data-effect-field="random_debuff.count" type="number" min="1" step="1" value="' + escapeHtml(randomDebuff.count ?? '') + '" placeholder="1"><small>Nº de atributos sorteados para reduzir.</small></label>'
            + '<label class="effect-field"><span>Debuff aleatório: quanto</span><input class="control" data-effect-field="random_debuff.amount" type="number" step="1" value="' + escapeHtml(randomDebuff.amount ?? '') + '" placeholder="0"><small>Redução aplicada a cada atributo</small></label>'
            + '<label class="effect-field effect-field-wide"><span>Debuff aleatório: atributos</span><input class="control" data-effect-field="random_debuff.stats" value="' + escapeHtml(randomDebuffStats) + '" placeholder="speed, accuracy"><small>Nomes separados por vírgula (' + Model.RANDOM_DEBUFF_STATS.join(', ') + '). Vazio sorteia de todos.</small></label>'
            + '<label class="effect-field"><span>Buff aleatório: quantos</span><input class="control" data-effect-field="random_buff.count" type="number" min="1" step="1" value="' + escapeHtml(randomBuff.count ?? '') + '" placeholder="1"><small>Nº de atributos sorteados para subir.</small></label>'
            + '<label class="effect-field"><span>Buff aleatório: quanto</span><input class="control" data-effect-field="random_buff.amount" type="number" step="1" value="' + escapeHtml(randomBuff.amount ?? '') + '" placeholder="0"><small>Aumento aplicado a cada atributo</small></label>'
            + '<label class="effect-field effect-field-wide"><span>Buff aleatório: atributos</span><input class="control" data-effect-field="random_buff.stats" value="' + escapeHtml(randomBuffStats) + '" placeholder="speed, accuracy"><small>Nomes separados por vírgula (' + Model.RANDOM_DEBUFF_STATS.join(', ') + '). Vazio sorteia de todos.</small></label>'
            + '<label class="effect-field"><span>Alvos ao acaso: mín.</span><input class="control" data-effect-field="random_targets.min" type="number" min="1" step="1" value="' + escapeHtml(randomTargets.min ?? '') + '" placeholder="1"></label>'
            + '<label class="effect-field"><span>Alvos ao acaso: máx.</span><input class="control" data-effect-field="random_targets.max" type="number" min="1" step="1" value="' + escapeHtml(randomTargets.max ?? '') + '" placeholder="mín."></label>'
            + '</div>'
            + '<span class="effect-group-title">Imunidade a dano</span>'
            + '<label class="effect-stack"><input type="checkbox" data-effect-immunity="physical" ' + (damageImmunities.indexOf('physical') !== -1 ? 'checked' : '') + '> Imune a dano físico durante o efeito</label>'
            + '<label class="effect-stack"><input type="checkbox" data-effect-immunity="magical" ' + (damageImmunities.indexOf('magical') !== -1 ? 'checked' : '') + '> Imune a dano mágico durante o efeito</label>'
            + '</div>'
            + '<div class="effect-advanced-group">'
            + '<span class="effect-group-title">Custos e manutenção</span>'
            + '<div class="form-grid effect-main-grid">'
            + '<label class="effect-field"><span>Vida paga no turno seguinte</span><input class="control" data-effect-field="deferred_cost.hp" type="number" min="0" value="' + escapeHtml(deferredCost.hp ?? '') + '" placeholder="0"><small>Uma dívida: paga-se no início do turno seguinte de quem usa a skill.</small></label>'
            + '<label class="effect-field"><span>Custo por alvo atingido</span><input class="control" data-effect-field="self_damage_per_target" type="number" min="0" value="' + escapeHtml(effect.self_damage_per_target ?? '') + '" placeholder="0"><small>Vida perdida por cada inimigo alcançado.</small></label>'
            + '<label class="effect-field"><span>O dreno vai para</span><select class="control" data-effect-field="drain_to">'
            + optionMarkup('target', 'O alvo perde', (effect.drain_to || 'target') === 'target')
            + optionMarkup('caster', 'Quem usa a skill recebe', effect.drain_to === 'caster') + '</select></label>'
            + '</div></div>'
            + '<div class="effect-advanced-group">'
            + '<span class="effect-group-title">Vento (caeli)</span>'
            + '<div class="form-grid effect-main-grid">'
            + '<label class="effect-stack"><input type="checkbox" data-effect-field="condition.requires_pending" ' + ((effect.condition || {}).requires_pending ? 'checked' : '') + '> Só aplica se o alvo ainda não agiu nesta ronda</label>'
            + '<label class="effect-stack"><input type="checkbox" data-effect-field="condition.requires_acted" ' + ((effect.condition || {}).requires_acted ? 'checked' : '') + '> Só aplica se o alvo já agiu nesta ronda</label>'
            + '<label class="effect-field"><span>Condição de linha</span><select class="control" data-effect-field="condition.target_line">'
            + optionMarkup('', 'Qualquer linha', !((effect.condition || {}).target_line))
            + optionMarkup('front', 'Só na frente', (effect.condition || {}).target_line === 'front')
            + optionMarkup('rear', 'Só atrás', (effect.condition || {}).target_line === 'rear')
            + '</select></label>'
            + '<label class="effect-field"><span>Linha cheia exigida</span><select class="control" data-effect-field="condition.requires_no_space">'
            + optionMarkup('', 'Nenhuma', !((effect.condition || {}).requires_no_space))
            + optionMarkup('front', 'Só se a frente estiver cheia', (effect.condition || {}).requires_no_space === 'front')
            + optionMarkup('rear', 'Só se atrás estiver cheio', (effect.condition || {}).requires_no_space === 'rear')
            + '</select></label>'
            + '<label class="effect-stack"><input type="checkbox" data-effect-field="lane_change_free" ' + (effect.lane_change_free ? 'checked' : '') + '> O portador troca de linha sem gastar o turno</label>'
            + '<label class="effect-field"><span>O efeito termina</span><select class="control" data-effect-field="expires">'
            + optionMarkup('', 'Nos turnos normais', !effect.expires)
            + optionMarkup('turn_start', 'Quando o portador começar o próximo turno', effect.expires === 'turn_start')
            + optionMarkup('turn_end', 'Quando o portador terminar o turno em curso', effect.expires === 'turn_end')
            + optionMarkup('round_end', 'No fim da ronda', effect.expires === 'round_end')
            + '</select></label>'
            + '</div></div>'
            + '<div class="effect-advanced-group">'
            + '<span class="effect-group-title">Céu (caeli)</span>'
            + '<div class="form-grid effect-main-grid">'
            + pairsEditor('Reforço de efeitos por elemento', effect.element_power || {}, 'element_power_pairs', 'caeli: 1.15')
            + '<small>Multiplica os efeitos das skills de cada elemento lançadas por quem o carrega.</small>'
            + '</div></div>'
            + '<div class="effect-advanced-group">'
            + '<span class="effect-group-title">Polaridade</span>'
            + '<div class="form-grid effect-main-grid">'
            + '<label class="effect-field"><span>Polaridade</span><select class="control" data-effect-field="polarity">' + polarityOptions + '</select><small>Automática: buff → positive, debuff ou dano → negative, controlo → neutral.</small></label>'
            + '</div></div>'
            + '</details>';
    }

    function resourceInput(label, key, value, namespace) {
        return '<label class="effect-field"><span>' + label + '</span><input class="control" data-effect-resource="' + namespace + '.' + key + '" type="number" min="0" value="' + escapeHtml(value ?? '') + '" placeholder="0"></label>';
    }

    /** Editor de pares "chave: valor" (String, modulações elementais). */
    function pairsEditor(label, pairs, fieldKey, placeholder) {
        var text = Object.keys(pairs).map(function (key) { return key + ': ' + pairs[key]; }).join(', ');
        return '<label class="effect-field effect-field-wide"><span>' + label + '</span><input class="control" data-effect-field="' + fieldKey + '" value="' + escapeHtml(text) + '" placeholder="' + placeholder + '"><small>Pares separados por vírgulas.</small></label>';
    }

    /** Editor de linhas de atributo de dentro de um objeto aninhado (spawn.debuff). */
    function statRowsPicker(owner, statsPath, label) {
        var parts = statsPath.split('.');
        var stats = (owner[parts[0]] || {})[parts[1]] || {};
        var rows = Object.keys(stats).map(function (name) {
            return '<div class="stat-row" data-stat-row>'
                + '<select class="control control-small" data-stat-name>' + Model.STAT_NAMES.map(function (id) {
                    return optionMarkup(id, Model.STAT_LABELS[id] || id, id === name);
                }).join('') + '</select>'
                + '<input class="control control-small" data-stat-value type="number" step="1" value="' + escapeHtml(stats[name]) + '">'
                + '<button class="icon-button icon-button-small" type="button" data-remove-stat title="Remover atributo">×</button>'
                + '</div>';
        }).join('');
        return '<div class="effect-field effect-field-wide" data-effect-stats="' + statsPath + '">'
            + '<span>' + label + '</span>'
            + (rows || '<p class="no-effects">Sem atributos — usa “+ Atributo”.</p>')
            + '<button class="button button-small button-quiet" type="button" data-add-stat>+ Atributo</button>'
            + '</div>';
    }

    function listValue(list) { return Array.isArray(list) ? list.join(', ') : (list || ''); }

    /** Guarda percentagens como frações (0…1) e mostra-nas 0…100. */
    function percentOf(value) {
        if (value === undefined || value === null || value === '') return '';
        var number = Number(value);
        return Number.isFinite(number) ? Math.round(number * 100) : '';
    }

    function asPercent(holder) {
        if (!holder || typeof holder !== 'object') return '';
        return percentOf(holder.percent);
    }

    function targetOptions(selected, skill) {
        var labels = { allies_all: 'Todos os aliados', enemies_all: 'Todos os inimigos', both_teams: 'Ambas as equipas' };
        var targets = availableTeamTargets(skill);
        if (['allies_all', 'enemies_all', 'both_teams'].includes(selected) && !targets.includes(selected)) {
            targets = targets.concat(selected);
        }
        return targets.map(function (target) {
            var label = labels[target] + (availableTeamTargets(skill).includes(target) ? '' : ' · existente');
            return optionMarkup(target, label, selected === target);
        }).join('');
    }

    function detectPattern(effect) {
        if (effect.damage_reduction) return 'damage_reduction';
        if (effect.cleanse_on_heal) return 'cleanse_on_heal';
        if (effect.cleanse_dot) return 'cleanse_dot';
        if ((effect.regen_bonus_per_negative ?? 0) > 0 || (effect.regen_bonus_per_dot_percent ?? 0) > 0) return 'regen_bonus';
        if (effect.refund_spent) return 'refund_spent';
        if (effect.drain_percent_of_max_hp) return 'drain_max';
        if (effect.drain_per_turn) return 'drain_turn';
        if (effect.regen_lowest_percent) return 'regen_lowest';
        if (effect.movement_immunity) return 'movement_immune';
        if (effect.stat_multipliers) return 'stat_multipliers';
        if (effect.charges) return 'charges';
        if (effect.trip_on_action) return 'trip';
        if (effect.spend_trigger) return 'spend_trigger';
        if (effect.cleanse_per_turn) return 'cleanse_turn';
        if (effect.regen_per_turn_percent) return 'regen_max';
        if (effect.resource_regen_percent_of_max) return 'regen_max_once';
        if (effect.random_resource_regen || effect.random_resource_regen_per_turn) return 'random_regen';
        if (effect.heal_percent_of_max) return 'heal_max';
        if (effect.upgrade_vs_status) return 'upgrade_status';
        if (effect.element_modulation || effect.expire_on_elements) return 'modulate';
        if (effect.shield_percent_of_max_hp !== undefined || effect.shield) return 'shield_effect';
        if (effect.cleanse !== undefined || effect.cleanse_all) return 'cleanse';
        if (effect.dispel !== undefined || effect.dispel_all || effect.dispel_status) return 'dispel';
        if (effect.deferred_damage) return 'deferred';
        if (effect.echo) return 'echo';
        if (effect.move) return 'move';
        if (effect.turn_postpone) return 'stall';
        if (effect.on_miss_move) return 'react_move';
        if (effect.weather) return 'weather';
        if (effect.projectile_accuracy) return 'sight';
        if (effect.projectile_mark) return 'mark';
        if (effect.ranged_evasion) return 'veil';
        if (effect.projectile_reroll) return 'reroll';
        if (effect.rewind) return 'rewind';
        if (effect.detonate_on_turn) return 'detonate';
        if (effect.chain_detonation) return 'chain_detonation';
        if (effect.conductor) return 'conductor';
        if (effect.interrupt) return 'interrupt';
        if (effect.reflect) return 'reflect';
        if (effect.spend_steal) return 'spend_steal';
        if (effect.evade_next) return 'evade_next';
        if (effect.damage_redirect) return 'damage_redirect';
        if (effect.cost_multiplier) return 'cost_multiplier';
        if (effect.end_cost) return 'end_cost';
        if (effect.on_death_blast) return 'on_death_blast';
        if (effect.stacking && effect.turn_end_stacks) return 'burst_stacks';
        if (effect.stacking && effect.damage_per_turn) return 'stack_dot';
        if (effect.fire_wall) return 'fire_wall';
        if (effect.element_damage) return 'element_damage';
        if (effect.projectile_element) return 'projectile_element';
        if (effect.ignite_attacker_on_hit) return 'ignite_attacker';
        if (effect.turn_end_burn) return 'turn_end_burn';
        if (effect.cleanse_dot) return 'cleanse_dot';
        if ((effect.regen_bonus_per_negative ?? 0) > 0 || (effect.regen_bonus_per_dot_percent ?? 0) > 0) return 'regen_bonus';
        if (effect.regen_lowest_percent) return 'regen_lowest';
        if (effect.refund_spent) return 'refund_spent';
        if (effect.cleanse_on_heal) return 'cleanse_on_heal';
        if (effect.damage_reduction) return 'damage_reduction';
        if (effect.drain_percent_of_max_hp) return 'drain_max';
        if (effect.drain_per_turn) return 'drain_turn';
        if (effect.movement_immunity) return 'movement_immune';
        if (effect.stat_multipliers) return 'stat_multipliers';
        if (effect.self_upkeep) return 'upkeep';
        if (effect.regen_per_turn) return 'regen_turn';
        if (effect.resource_transfer) return 'transfer';
        if (effect.resource_regen) return 'regen';
        if (effect.buff) return 'buff';
        if (effect.debuff) return 'debuff';
        if (effect.resource_drain) return 'drain';
        if (effect.damage !== undefined || effect.damage_per_turn !== undefined) return 'damage';
        return 'regen';
    }

    function handleEffectActions(event) {
        var addButton = event.target.closest('[data-add-effect]');
        if (addButton) {
            addEffect(addButton.dataset.addEffect, addButton.dataset.pattern);
            return;
        }
        var removeButton = event.target.closest('[data-remove-effect]');
        if (removeButton) {
            var skill = currentSkill();
            if (!skill) return;
            skill.effects = (skill.effects || []).filter(function (effect) { return effect.effect_id !== removeButton.dataset.removeEffect; });
            persist();
            renderEffectScopes(skill);
            renderInspector();
            renderSkillSummary(skill);
            return;
        }
        var addStat = event.target.closest('[data-add-stat]');
        if (addStat) {
            var owner = currentSkill();
            var container = addStat.closest('[data-effect-stats]');
            if (!owner || !container) return;
            var wrapper = document.createElement('div');
            wrapper.innerHTML = '<div class="stat-row" data-stat-row>'
                + '<select class="control control-small" data-stat-name>' + Model.STAT_NAMES.map(function (id) {
                    return optionMarkup(id, Model.STAT_LABELS[id] || id, id === 'physical_attack');
                }).join('') + '</select>'
                + '<input class="control control-small" data-stat-value type="number" step="1" value="10">'
                + '<button class="icon-button icon-button-small" type="button" data-remove-stat title="Remover atributo">×</button>'
                + '</div>';
            container.appendChild(wrapper.firstElementChild);
            syncEffectCards(owner);
            persist();
            renderInspector();
            return;
        }
        var removeStat = event.target.closest('[data-remove-stat]');
        if (removeStat) {
            var statOwner = currentSkill();
            var row = removeStat.closest('[data-stat-row]');
            if (!statOwner || !row) return;
            row.remove();
            syncEffectCards(statOwner);
            persist();
            renderInspector();
            return;
        }
        var removeBonus = event.target.closest('[data-remove-bonus]');
        if (removeBonus) {
            var bonusOwner = currentSkill();
            var bonusRow = removeBonus.closest('.bonus-row');
            if (!bonusOwner || !bonusRow) return;
            bonusRow.remove();
            syncBonusVs(bonusOwner);
            persist();
            renderInspector();
            renderSkillSummary(bonusOwner);
        }
    }

    function addEffect(scope, pattern) {
        var skill = currentSkill();
        if (!skill) return;
        skill.effects = skill.effects || [];
        var effectIndex = 1;
        var id = skill.id + '_effect_' + effectIndex;
        while (skill.effects.some(function (effect) { return effect.effect_id === id; })) id = skill.id + '_effect_' + (++effectIndex);
        var applyTo = scope === 'self' ? 'self' : scope === 'target' ? 'target' : defaultTeamTarget(skill);
        var properties = {};
        if (pattern === 'regen') properties.resource_regen = { hp: 15 };
        if (pattern === 'regen_turn') properties.regen_per_turn = { hp: 10 };
        if (pattern === 'regen_max') properties.regen_per_turn_percent = { hp: 10 };
        if (pattern === 'regen_max_once') properties.resource_regen_percent_of_max = { hp: 10 };
        if (pattern === 'random_regen') properties.random_resource_regen = { percent: 10 };
        if (pattern === 'heal_max') properties.heal_percent_of_max = 8;
        if (pattern === 'spend_trigger') properties.spend_trigger = { damage: 6, heal_to_source: 3 };
        if (pattern === 'modulate') { properties.element_modulation = { ignis: 0.25 }; properties.expire_on_elements = ['ignis']; }
        if (pattern === 'shield_effect') properties.shield = { percent_of_max_hp: 12 };
        if (pattern === 'charges') properties.charges = { max: 3, initial: 1, release: { status_effect: 'Frozen', turns: 1 } };
        if (pattern === 'upgrade_status') properties.upgrade_vs_status = { status: 'Wet', extra_turns: 1 };
        if (pattern === 'trip') properties.trip_on_action = { actions: ['attack'], chance: 0.5, damage: 8 };
        if (pattern === 'cleanse_turn') properties.cleanse_per_turn = { count: 1, polarity: 'any' };
        if (pattern === 'buff') properties.buff = { physical_attack: 10 };
        if (pattern === 'debuff') properties.debuff = { physical_attack: 10 };
        if (pattern === 'damage') properties.damage_per_turn = 5;
        if (pattern === 'drain') properties.resource_drain = { hp: 8 };
        if (pattern === 'transfer') properties.resource_transfer = { resource: 'mana', amount: 10 };
        if (pattern === 'cleanse') properties.cleanse = 1;
        if (pattern === 'dispel') properties.dispel = 1;
        if (pattern === 'deferred') properties.deferred_damage = { amount: 12, after_turns: 2 };
        if (pattern === 'echo') properties.echo = { multiplier: 1 };
        if (pattern === 'move') properties.move = { who: 'target', to_line: 'rear' };
        if (pattern === 'stall') properties.turn_postpone = { slots: 1, condition: { requires_pending: true } };
        if (pattern === 'react_move') properties.on_miss_move = { who: 'self', to_line: 'other', break_after: true };
        if (pattern === 'weather') properties.weather = { rounds: 3, element_effect_multipliers: { aqua: 1.1 } };
        if (pattern === 'sight') properties.projectile_accuracy = { amount: 12 };
        if (pattern === 'mark') properties.projectile_mark = { accuracy: 15 };
        if (pattern === 'veil') properties.ranged_evasion = 15;
        if (pattern === 'reroll') properties.projectile_reroll = { per_turn: 1 };
        if (pattern === 'upkeep') properties.self_upkeep = { hp: 2 };
        if (pattern === 'rewind') properties.rewind = { turns: 1, resources: ['hp', 'mana', 'stamina'], cleanse: true };
        if (pattern === 'detonate') properties.detonate_on_turn = { power: 12, scale_per_turn: 2, max_power: 30, include_line: true };
        if (pattern === 'chain_detonation') properties.chain_detonation = { power: 8, recoil_per_target: 3 };
        if (pattern === 'conductor') properties.conductor = { jump_power: 8, grounded_by_elements: ['lapis'], ground_shield_percent: 12 };
        if (pattern === 'interrupt') properties.interrupt = { chance: 0.5, actions: ['skill', 'weapon'] };
        if (pattern === 'reflect') properties.reflect = { power: 8, chance: 1, consume: false };
        if (pattern === 'spend_steal') properties.spend_steal = { resource: 'mana', percent: 0.25, max: 15 };
        if (pattern === 'evade_next') properties.evade_next = { damage_types: ['physical'], power: 10, chance: 1 };
        if (pattern === 'damage_redirect') properties.damage_redirect = { scope: 'allies_all' };
        if (pattern === 'cost_multiplier') properties.cost_multiplier = { mana: 0.5, stamina: 0.5 };
        if (pattern === 'end_cost') properties.end_cost = { resource: 'stamina', percent_of_max: 50, shortfall: 'hp' };
        if (pattern === 'on_death_blast') properties.on_death_blast = { power: 40 };
        if (pattern === 'stack_dot') properties.stacking = { initial: 1, extend_turns: 1 };
        if (pattern === 'stack_dot') properties.damage_per_turn = 4;
        if (pattern === 'stack_dot') properties.damage_timing = 'turn_end';
        if (pattern === 'burst_stacks') properties.stacking = { initial: 1, extend_turns: 1 };
        if (pattern === 'burst_stacks') properties.turn_end_stacks = 1;
        if (pattern === 'burst_stacks') properties.burst_at = 4;
        if (pattern === 'burst_stacks') properties.burst = { damage: 10, burn_stacks: 1, burn_turns: 3, pdef_percent: 10, turns: 3 };
        if (pattern === 'fire_wall') properties.fire_wall = { ranged_weapon: 0.7, projectile: 0.7, physical: 1, erode_elements: ['aqua', 'caeli'] };
        if (pattern === 'element_damage') properties.element_damage = { ignis: 1.15 };
        if (pattern === 'projectile_element') properties.projectile_element = 'ignis';
        if (pattern === 'ignite_attacker') properties.ignite_attacker_on_hit = { damage_types: ['physical'], chance: 0.4, burn_stacks: 1, burn_turns: 2 };
        if (pattern === 'turn_end_burn') properties.turn_end_burn = { chance: 0.2, burn_stacks: 1, burn_turns: 2 };
        if (pattern === 'cleanse_dot') properties.cleanse_dot = 1;
        if (pattern === 'regen_bonus') { properties.regen_bonus_per_negative = 2; properties.regen_bonus_per_dot_percent = 4; }
        if (pattern === 'regen_lowest') properties.regen_lowest_percent = 6;
        if (pattern === 'refund_spent') properties.refund_spent = { percent: 0.25, resources: ['mana', 'stamina'] };
        if (pattern === 'cleanse_on_heal') properties.cleanse_on_heal = { count: 1, element: 'florere', max_triggers: 3 };
        if (pattern === 'damage_reduction') properties.damage_reduction = { percent: 0.15, charges: 2, heal_adjacent_percent: 6 };
        if (pattern === 'drain_max') properties.drain_percent_of_max_hp = { percent: 8, resource: 'hp', to: 'caster' };
        if (pattern === 'drain_turn') properties.drain_per_turn = { resource: 'hp', percent_of_max: 6, chance: 0.3, heal_to_source: true };
        if (pattern === 'movement_immune') properties.movement_immunity = true;
        if (pattern === 'stat_multipliers') properties.stat_multipliers = { physical_attack: 1.15 };
        skill.effects.push(Model.makeEffect(skill.id, pattern, applyTo, effectIndex - 1, properties));
        state.openScopes[skill.id] = state.openScopes[skill.id] || {};
        state.openScopes[skill.id][scope] = true;
        persist();
        renderEffectScopes(skill);
        renderInspector();
        renderSkillSummary(skill);
        var last = byId(scope + '-effects').lastElementChild;
        last?.querySelector('[data-effect-field="status_effect"]')?.focus();
    }

    function handleEffectInput(event) {
        if (!event.target.closest('[data-effect-card]')) return;
        var skill = currentSkill();
        if (!skill) return;
        syncEffectCards(skill);
        persist();
        renderInspector();
        renderTreeCanvas();
    }

    function handleEffectChange(event) {
        if (!event.target.closest('[data-effect-card]')) return;
        var skill = currentSkill();
        if (!skill) return;
        if (event.target.matches('[data-effect-pattern]')) changeEffectPattern(event.target);
        else {
            syncEffectCards(skill);
            persist();
            renderInspector();
            renderTreeCanvas();
        }
    }

    function changeEffectPattern(select) {
        var skill = currentSkill();
        var card = select.closest('[data-effect-card]');
        if (!skill || !card) return;
        var effect = skill.effects.find(function (item) { return item.effect_id === card.dataset.effectId; });
        if (!effect) return;
        ['buff', 'debuff', 'resource_regen', 'regen_per_turn', 'regen_per_turn_percent', 'random_resource_regen', 'random_resource_regen_per_turn', 'resource_regen_percent_of_max', 'heal_percent_of_max', 'spend_trigger', 'upgrade_vs_status', 'element_modulation', 'expire_on_elements', 'cleanse_per_turn', 'shield', 'charges', 'trip_on_action', 'also_remove_status', 'resource_drain', 'resource_transfer', 'damage', 'damage_per_turn', 'damage_variance', 'cleanse', 'cleanse_all', 'dispel', 'dispel_all', 'dispel_status', 'deferred_damage', 'echo', 'move', 'self_upkeep', 'rewind', 'turn_postpone', 'on_miss_move', 'lane_change_free', 'expires', 'weather', 'projectile_accuracy', 'projectile_mark', 'ranged_evasion', 'projectile_reroll', 'detonate_on_turn', 'chain_detonation', 'conductor', 'interrupt', 'reflect', 'spend_steal', 'evade_next', 'damage_redirect', 'cost_multiplier', 'end_cost', 'on_death_blast', 'cleanse_dot', 'regen_bonus_per_negative', 'regen_bonus_per_dot_percent', 'regen_lowest_percent', 'refund_spent', 'cleanse_on_heal', 'damage_reduction', 'drain_percent_of_max_hp', 'drain_per_turn', 'movement_immunity', 'stat_multipliers'].forEach(function (key) { delete effect[key]; });
        var type = select.value;
        if (type === 'regen') effect.resource_regen = { hp: 15 };
        if (type === 'regen_turn') effect.regen_per_turn = { hp: 10 };
        if (type === 'regen_max') effect.regen_per_turn_percent = { hp: 10 };
        if (type === 'regen_max_once') effect.resource_regen_percent_of_max = { hp: 10 };
        if (type === 'random_regen') effect.random_resource_regen = { percent: 10 };
        if (type === 'heal_max') effect.heal_percent_of_max = 8;
        if (type === 'spend_trigger') effect.spend_trigger = { damage: 6, heal_to_source: 3 };
        if (type === 'modulate') { effect.element_modulation = { ignis: 0.25 }; effect.expire_on_elements = ['ignis']; }
        if (type === 'shield_effect') effect.shield = { percent_of_max_hp: 12 };
        if (type === 'charges') effect.charges = { max: 3, initial: 1, release: { status_effect: 'Frozen', turns: 1 } };
        if (type === 'upgrade_status') effect.upgrade_vs_status = { status: 'Wet', extra_turns: 1 };
        if (type === 'trip') effect.trip_on_action = { actions: ['attack'], chance: 0.5, damage: 8 };
        if (type === 'cleanse_turn') effect.cleanse_per_turn = { count: 1, polarity: 'any' };
        if (type === 'buff') effect.buff = { physical_attack: 10 };
        if (type === 'debuff') effect.debuff = { physical_attack: 10 };
        if (type === 'damage') effect.damage_per_turn = 5;
        if (type === 'drain') effect.resource_drain = { hp: 8 };
        if (type === 'transfer') effect.resource_transfer = { resource: 'mana', amount: 10 };
        if (type === 'cleanse') effect.cleanse = 1;
        if (type === 'dispel') effect.dispel = 1;
        if (type === 'deferred') effect.deferred_damage = { amount: 12, after_turns: 2 };
        if (type === 'echo') effect.echo = { multiplier: 1 };
        if (type === 'move') effect.move = { who: 'target', to_line: 'rear' };
        if (type === 'stall') effect.turn_postpone = { slots: 1, condition: { requires_pending: true } };
        if (type === 'react_move') effect.on_miss_move = { who: 'self', to_line: 'other', break_after: true };
        if (type === 'weather') effect.weather = { rounds: 3, element_effect_multipliers: { aqua: 1.1 } };
        if (type === 'sight') effect.projectile_accuracy = { amount: 12 };
        if (type === 'mark') effect.projectile_mark = { accuracy: 15 };
        if (type === 'veil') effect.ranged_evasion = 15;
        if (type === 'reroll') effect.projectile_reroll = { per_turn: 1 };
        if (type === 'upkeep') effect.self_upkeep = { hp: 2 };
        if (type === 'rewind') effect.rewind = { turns: 1, resources: ['hp', 'mana', 'stamina'], cleanse: true };
        if (type === 'detonate') effect.detonate_on_turn = { power: 12, scale_per_turn: 2, max_power: 30, include_line: true };
        if (type === 'chain_detonation') effect.chain_detonation = { power: 8, recoil_per_target: 3 };
        if (type === 'conductor') effect.conductor = { jump_power: 8, grounded_by_elements: ['lapis'], ground_shield_percent: 12 };
        if (type === 'interrupt') effect.interrupt = { chance: 0.5, actions: ['skill', 'weapon'] };
        if (type === 'reflect') effect.reflect = { power: 8, chance: 1, consume: false };
        if (type === 'spend_steal') effect.spend_steal = { resource: 'mana', percent: 0.25, max: 15 };
        if (type === 'evade_next') effect.evade_next = { damage_types: ['physical'], power: 10, chance: 1 };
        if (type === 'damage_redirect') effect.damage_redirect = { scope: 'allies_all' };
        if (type === 'cost_multiplier') effect.cost_multiplier = { mana: 0.5, stamina: 0.5 };
        if (type === 'end_cost') effect.end_cost = { resource: 'stamina', percent_of_max: 50, shortfall: 'hp' };
        if (type === 'on_death_blast') effect.on_death_blast = { power: 40 };
        if (type === 'stack_dot') effect.stacking = { initial: 1, extend_turns: 1 };
        if (type === 'stack_dot') effect.damage_per_turn = 4;
        if (type === 'stack_dot') effect.damage_timing = 'turn_end';
        if (type === 'burst_stacks') effect.stacking = { initial: 1, extend_turns: 1 };
        if (type === 'burst_stacks') effect.turn_end_stacks = 1;
        if (type === 'burst_stacks') effect.burst_at = 4;
        if (type === 'burst_stacks') effect.burst = { damage: 10, burn_stacks: 1, burn_turns: 3, pdef_percent: 10, turns: 3 };
        if (type === 'fire_wall') effect.fire_wall = { ranged_weapon: 0.7, projectile: 0.7, physical: 1, erode_elements: ['aqua', 'caeli'] };
        if (type === 'element_damage') effect.element_damage = { ignis: 1.15 };
        if (type === 'projectile_element') effect.projectile_element = 'ignis';
        if (type === 'ignite_attacker') effect.ignite_attacker_on_hit = { damage_types: ['physical'], chance: 0.4, burn_stacks: 1, burn_turns: 2 };
        if (type === 'turn_end_burn') effect.turn_end_burn = { chance: 0.2, burn_stacks: 1, burn_turns: 2 };
        if (type === 'cleanse_dot') effect.cleanse_dot = 1;
        if (type === 'regen_bonus') { effect.regen_bonus_per_negative = 2; effect.regen_bonus_per_dot_percent = 4; }
        if (type === 'regen_lowest') effect.regen_lowest_percent = 6;
        if (type === 'refund_spent') effect.refund_spent = { percent: 0.25, resources: ['mana', 'stamina'] };
        if (type === 'cleanse_on_heal') effect.cleanse_on_heal = { count: 1, element: 'florere', max_triggers: 3 };
        if (type === 'damage_reduction') effect.damage_reduction = { percent: 0.15, charges: 2, heal_adjacent_percent: 6 };
        if (type === 'drain_max') effect.drain_percent_of_max_hp = { percent: 8, resource: 'hp', to: 'caster' };
        if (type === 'drain_turn') effect.drain_per_turn = { resource: 'hp', percent_of_max: 6, chance: 0.3, heal_to_source: true };
        if (type === 'movement_immune') effect.movement_immunity = true;
        if (type === 'stat_multipliers') effect.stat_multipliers = { physical_attack: 1.15 };
        // O nome do estado segue a operação, mas só enquanto o autor não o
        // tiver escrito por si.
        if (Object.values(Model.PATTERN_STATUS_NAMES || {}).includes(effect.status_effect)) {
            effect.status_effect = Model.patternStatusName(type);
        }
        persist();
        renderEffects(skill, card.dataset.effectScope);
        renderInspector();
        renderSkillSummary(skill);
    }

    function syncEffectCards(skill) {
        var original = skill.effects || [];
        var updatedById = new Map();
        document.querySelectorAll('[data-effect-card]').forEach(function (card) {
            var effect = original.find(function (item) { return item.effect_id === card.dataset.effectId; });
            if (!effect) return;
            if (card.dataset.effectScope === 'self') effect.apply_to = 'self';
            else if (card.dataset.effectScope === 'target' && (!effect.apply_to || effect.apply_to === 'target')) effect.apply_to = 'target';
            else if (card.dataset.effectScope === 'team' && !effect.apply_to) effect.apply_to = defaultTeamTarget(skill);
            card.querySelectorAll('[data-effect-field]').forEach(function (field) {
                var key = field.dataset.effectField;
                if (key === 'element_id') {
                    if (field.value) effect.element_id = field.value;
                    else delete effect.element_id;
                } else if (key === 'status_effect') {
                    effect.status_effect = field.value;
                } else if (key === 'apply_to') {
                    effect.apply_to = field.value;
                } else if (key === 'turns') {
                    effect.turns = numberValue(field.value, 0);
                } else if (key === 'effect_hit_chance') {
                    var chance = numberValue(field.value, 100) / 100;
                    if (chance >= 1) delete effect.effect_hit_chance;
                    else effect.effect_hit_chance = chance;
                } else if (key === 'can_stack') {
                    if (field.checked) effect.can_stack = true;
                    else delete effect.can_stack;
                } else if (key === 'damage' || key === 'damage_per_turn' || key === 'heal'
                    || key === 'cleanse' || key === 'dispel') {
                    if (field.value === '') delete effect[key];
                    else effect[key] = numberValue(field.value, 0);
                } else if (key === 'cleanse_all' || key === 'dispel_all') {
                    if (field.checked) effect[key] = true;
                    else delete effect[key];
                } else if (key === 'dispel_status') {
                    if (field.value.trim()) effect.dispel_status = field.value.trim();
                    else delete effect.dispel_status;
                } else if (key === 'polarity') {
                    if (field.value) effect.polarity = field.value;
                    else delete effect.polarity;
                } else if (key === 'status_immunities' || key === 'prevent_actions'
                    || key === 'expire_on_elements' || key === 'also_remove_status'
                    || key === 'block_stat_buffs' || key === 'counter_except_elements'
                    || key === 'prevent_damage_channels') {
                    var list = String(field.value || '').split(',').map(function (entry) { return entry.trim(); }).filter(Boolean);
                    if (list.length) effect[key] = list;
                    else delete effect[key];
                } else if (key === 'element_modulation_pairs' || key === 'damage_channel_modulation_pairs'
                    || key === 'upgrade_regen_pairs' || key === 'element_power_pairs' || key === 'weather_element_pairs'
                    || key === 'stat_multiplier_pairs' || key === 'element_damage_pairs' || key === 'wash_on_elements_pairs') {
                    // Pares "chave: valor"; cada editor dirige o seu destino.
                    var targetKey = key === 'element_modulation_pairs' ? 'element_modulation'
                        : key === 'damage_channel_modulation_pairs' ? 'damage_channel_modulation'
                            : key === 'element_power_pairs' ? 'element_power'
                                : key === 'weather_element_pairs' ? 'weather.element_effect_multipliers'
                                    : key === 'stat_multiplier_pairs' ? 'stat_multipliers'
                                        : key === 'element_damage_pairs' ? 'element_damage'
                                            : key === 'wash_on_elements_pairs' ? 'wash_on_elements'
                                                : 'upgrade_vs_status.extra_regen_per_turn_percent';
                    var parsedPairs = {};
                    String(field.value || '').split(',').forEach(function (entry) {
                        var halves = entry.split(':');
                        var pairKey = (halves[0] || '').trim();
                        var pairValue = Number((halves[1] ?? '').trim());
                        if (pairKey && Number.isFinite(pairValue) && pairValue !== 0) parsedPairs[pairKey] = pairValue;
                    });
                    if (Object.keys(parsedPairs).length) setNested(effect, targetKey, parsedPairs);
                    else { setNested(effect, targetKey, undefined); pruneEmpty(effect, targetKey); }
                } else if (key === 'shield.hit_chance' || key === 'trip_on_action.chance'
                    || key === 'upgrade_vs_status.extra_turns_chance'
                    || key === 'detonate_on_turn.turn_skip_chance'
                    || key === 'interrupt.chance' || key === 'reflect.chance'
                    || key === 'spend_steal.percent' || key === 'evade_next.chance'
                    || key === 'refund_spent.percent' || key === 'damage_reduction.percent'
                    || key === 'drain_per_turn.chance' || key === 'ignite_attacker_on_hit.chance'
                    || key === 'turn_end_burn.chance') {
                    // Mostram-se em percentagem mas guardam-se como fração.
                    var fractionLeaf = key.split('.');
                    var fractionParent = readNested(effect, fractionLeaf.slice(0, -1).join('.')) || {};
                    var fractionName = fractionLeaf[fractionLeaf.length - 1];
                    if (field.value === '') {
                        delete fractionParent[fractionName];
                        pruneEmpty(effect, key);
                    } else {
                        // Garante o pai mesmo que só a chance exista.
                        var parentPath = fractionLeaf.slice(0, -1).join('.');
                        setNested(effect, parentPath + '.' + fractionName,
                            numberValue(field.value, 100) / 100 >= 1 ? 1 : numberValue(field.value, 100) / 100);
                    }
                } else if (key === 'trip_on_action.actions' || key === 'trip_on_action.damage_types'
                    || key === 'charges.release.prevent_actions'
                    || key === 'trip_on_action.spawn.prevent_actions'
                    || key === 'conductor.grounded_by_elements' || key === 'interrupt.actions'
                    || key === 'evade_next.damage_types' || key === 'refund_spent.resources'
                    || key === 'fire_wall.erode_elements' || key === 'ignite_attacker_on_hit.damage_types') {
                    var commaLeaf = key.split('.');
                    var commaName = commaLeaf[commaLeaf.length - 1];
                    var commaList = String(field.value || '').split(',').map(function (entry) { return entry.trim(); }).filter(Boolean);
                    if (commaList.length) setNested(effect, key, commaList);
                    else {
                        setNested(effect, key, undefined);
                        pruneEmpty(effect, key);
                    }
                } else if (key === 'drain_percent_of_damage' || key === 'heal_on_kill_percent' || key === 'confusion_chance') {
                    // Mostram-se em percentagem mas guardam-se como fração, à
                    // maneira da precisão do efeito.
                    if (field.value === '') delete effect[key];
                    else {
                        var fraction = numberValue(field.value, 0) / 100;
                        if (fraction >= 1) effect[key] = 1;
                        else effect[key] = fraction;
                    }
                } else if (key === 'heal_on_kill') {
                    if (field.value === '') delete effect.heal_on_kill;
                    else effect.heal_on_kill = numberValue(field.value, 0);
                } else if (key === 'set_phase') {
                    if (field.value) effect.set_phase = field.value;
                    else {
                        delete effect.set_phase;
                        delete effect.phase_rounds;
                    }
                } else if (key === 'phase_rounds') {
                    if (field.value === '' || !effect.set_phase) delete effect.phase_rounds;
                    else effect.phase_rounds = numberValue(field.value, 5);
                } else if (key === 'random_debuff.stats') {
                    var debuffStats = String(field.value || '').split(',').map(function (entry) { return entry.trim(); }).filter(Boolean);
                    effect.random_debuff = effect.random_debuff || {};
                    if (debuffStats.length) effect.random_debuff.stats = debuffStats;
                    else delete effect.random_debuff.stats;
                } else if (key === 'random_buff.stats') {
                    var buffStats = String(field.value || '').split(',').map(function (entry) { return entry.trim(); }).filter(Boolean);
                    effect.random_buff = effect.random_buff || {};
                    if (buffStats.length) effect.random_buff.stats = buffStats;
                    else delete effect.random_buff.stats;
                } else if (key.indexOf('rewind.resources.') === 0) {
                    // Os recursos recuperados são uma lista, não um campo solto.
                    var rewindResource = key.slice('rewind.resources.'.length);
                    effect.rewind = effect.rewind || {};
                    var rewindList = Array.isArray(effect.rewind.resources) ? effect.rewind.resources.slice() : [];
                    if (field.checked) {
                        if (rewindList.indexOf(rewindResource) === -1) rewindList.push(rewindResource);
                    } else {
                        rewindList = rewindList.filter(function (entry) { return entry !== rewindResource; });
                    }
                    effect.rewind.resources = rewindList;
                } else if (key === 'rewind.turns') {
                    effect.rewind = effect.rewind || {};
                    var rewindTurns = numberValue(field.value, 0);
                    // 0 significa "até ao início da luta", e é o que o motor
                    // lê quando o campo não existe.
                    if (rewindTurns > 0) effect.rewind.turns = rewindTurns;
                    else delete effect.rewind.turns;
                } else if (key === 'rewind.cleanse') {
                    effect.rewind = effect.rewind || {};
                    effect.rewind.cleanse = field.checked;
                } else if (key.indexOf('.') !== -1) {
                    // Campos aninhados: move.who, deferred_damage.amount, …
                    var nestedValue;
                    if (field.type === 'checkbox') nestedValue = field.checked ? true : undefined;
                    else if (field.value === '') nestedValue = undefined;
                    else nestedValue = fieldValue(field.value);
                    setNested(effect, key, nestedValue);
                    if (nestedValue === undefined) pruneEmpty(effect, key);
                } else if (field.type === 'checkbox') {
                    if (field.checked) effect[key] = true;
                    else delete effect[key];
                } else if (field.value === '') {
                    delete effect[key];
                } else {
                    effect[key] = fieldValue(field.value);
                }
            });

            card.querySelectorAll('[data-effect-resource]').forEach(function (field) {
                var parts = field.dataset.effectResource.split('.');
                effect[parts[0]] = effect[parts[0]] || {};
                if (field.value === '') delete effect[parts[0]][parts[1]];
                else effect[parts[0]][parts[1]] = numberValue(field.value, 0);
                if (!Object.keys(effect[parts[0]]).length) delete effect[parts[0]];
            });
            card.querySelectorAll('[data-effect-stats]').forEach(function (field) {
                var key = field.dataset.effectStats;
                var parsed = {};
                field.querySelectorAll('[data-stat-row]').forEach(function (row) {
                    var name = row.querySelector('[data-stat-name]')?.value;
                    var amount = numberValue(row.querySelector('[data-stat-value]')?.value, 0);
                    if (name) parsed[name] = amount;
                });
                if (key.indexOf('.') === -1) {
                    if (Object.keys(parsed).length) effect[key] = parsed;
                    else delete effect[key];
                    return;
                }
                // Caminho aninhado (`trip_on_action.spawn.debuff`).
                if (Object.keys(parsed).length) setNested(effect, key, parsed);
                else {
                    setNested(effect, key, undefined);
                    pruneEmpty(effect, key);
                }
            });
            var minVariance = card.querySelector('[data-effect-variance="min"]');
            var maxVariance = card.querySelector('[data-effect-variance="max"]');
            if (minVariance && maxVariance) {
                var variance = [numberValue(minVariance.value, 1), numberValue(maxVariance.value, 1)];
                if (variance[0] !== 1 || variance[1] !== 1) effect.damage_variance = variance;
                else delete effect.damage_variance;
            }
            var drainResource = card.querySelector('[data-effect-drain-resource]');
            var drainAmount = card.querySelector('[data-effect-drain-amount]');
            if (drainResource && drainAmount) effect.resource_drain = { [drainResource.value]: numberValue(drainAmount.value, 0) };
            var transferResource = card.querySelector('[data-effect-transfer-resource]');
            var transferAmount = card.querySelector('[data-effect-transfer-amount]');
            if (transferResource && transferAmount) {
                var transferAmountValue = numberValue(transferAmount.value, 0);
                if (transferAmountValue > 0) effect.resource_transfer = { resource: transferResource.value, amount: transferAmountValue };
                else delete effect.resource_transfer;
            }
            var immunityChecks = Array.from(card.querySelectorAll('[data-effect-immunity]'));
            if (immunityChecks.length) {
                var damageChannels = immunityChecks.filter(function (check) { return check.checked; })
                    .map(function (check) { return check.dataset.effectImmunity; });
                if (damageChannels.length) effect.damage_immunities = damageChannels;
                else delete effect.damage_immunities;
            }
            // Uma casca de `random_debuff` sem campos dentro não é mecânica: some.
            if (effect.random_debuff && typeof effect.random_debuff === 'object' && !Object.keys(effect.random_debuff).length) {
                delete effect.random_debuff;
            }
            // O mesmo para a casca do `random_buff`.
            if (effect.random_buff && typeof effect.random_buff === 'object' && !Object.keys(effect.random_buff).length) {
                delete effect.random_buff;
            }
            // Cascas vazias das novas mecânicas também somem.
            [['trip_on_action'], ['upgrade_vs_status'], ['charges'], ['spend_trigger'], ['cleanse_per_turn'], ['shield'], ['trip_on_action', 'spawn'], ['upgrade_vs_status', 'extra_regen_per_turn_percent'], ['condition'], ['turn_postpone'], ['turn_postpone', 'condition'], ['on_miss_move'], ['weather'], ['weather', 'element_effect_multipliers'], ['element_power'], ['projectile_accuracy'], ['projectile_mark'], ['projectile_reroll'], ['detonate_on_turn'], ['chain_detonation'], ['conductor'], ['interrupt'], ['reflect'], ['spend_steal'], ['evade_next'], ['damage_redirect'], ['cost_multiplier'], ['end_cost'], ['on_death_blast'], ['stacking'], ['fire_wall'], ['element_damage'], ['ignite_on_hit'], ['ignite_attacker_on_hit'], ['burst']].forEach(function (path) {
                var holder = effect;
                var valid = true;
                for (var index = 0; index < path.length; index += 1) {
                    if (!holder || typeof holder !== 'object') { valid = false; break; }
                    holder = holder[path[index]];
                }
                if (valid && holder && typeof holder === 'object' && !Object.keys(holder).length) {
                    var parent = effect;
                    for (var step = 0; step < path.length - 1; step += 1) parent = parent[path[step]];
                    delete parent[path[path.length - 1]];
                }
            });
            updateConditionalEffectFields(card, effect);
            updatedById.set(effect.effect_id, effect);
        });
        skill.effects = original.map(function (effect) { return updatedById.get(effect.effect_id) || effect; });
    }

    /** Campos que só têm sentido quando o campo-pai está ativo. */
    function updateConditionalEffectFields(card, effect) {
        var confusionField = card.querySelector('[data-effect-conditional="confusion_chance"]');
        if (confusionField) confusionField.hidden = !effect.confuse;
        if (!effect.confuse) delete effect.confusion_chance;
        var phaseField = card.querySelector('[data-effect-conditional="phase_rounds"]');
        if (phaseField) phaseField.hidden = !effect.set_phase;
        if (!effect.set_phase) delete effect.phase_rounds;
        var counterChanceField = card.querySelector('[data-effect-conditional="counter_chance"]');
        if (counterChanceField) counterChanceField.hidden = !(effect.counter || effect.counter_chance !== undefined);
    }

    function syncCollateral(skill) {
        var form = byId('skill-editor');
        if (!form.elements.collateral_enabled.checked) {
            delete skill.collateral;
            return;
        }
        var multiplierMin = numberValue(form.elements.collateral_multiplier_min.value, 0.5);
        var multiplierMax = numberValue(form.elements.collateral_multiplier_max.value, multiplierMin);
        skill.collateral = {
            chance: numberValue(form.elements.collateral_chance.value, 100) / 100,
            apply_to: form.elements.collateral_target.value,
            include_primary_targets: form.elements.collateral_include_primary.checked,
            include_caster: form.elements.collateral_include_caster.checked,
            damage_multiplier: [multiplierMin, multiplierMax],
        };
    }

    function updatePowerFields(saveAfter) {
        var form = byId('skill-editor');
        var kind = form.elements.power_kind.value;
        var extra = byId('power-extra');
        if (kind === 'random') {
            byId('power-label').textContent = 'Força mínima';
            extra.hidden = false;
            extra.innerHTML = '<label class="field"><span>Força máxima</span><input class="control" name="power_max" type="number" min="0" value="' + escapeHtml(form.elements.power_value.value || 20) + '"></label>';
        } else if (kind === 'attribute') {
            byId('power-label').textContent = 'Poder base';
            extra.hidden = false;
            extra.innerHTML = '<label class="field"><span>Ganho por ponto de atributo (per_point)</span><select class="control" name="power_stat"><option value="speed">speed</option><option value="magical_attack">magical_attack</option><option value="physical_attack">physical_attack</option></select></label>'
                + '<small>O motor soma <code>per_point × atributo</code> ao poder base em cada golpe (campo <code>power_scaling</code>).</small>';
        } else {
            byId('power-label').textContent = 'Poder';
            extra.hidden = true;
            extra.innerHTML = '';
        }
        if (saveAfter) {
            var skill = currentSkill();
            if (skill) { syncSkillFromEditor(skill); persist(); }
        }
    }

    function updateEditorFeedback(skill, elementChanged) {
        byId('current-id').textContent = skill.id;
        byId('direct-cost').textContent = (Number(skill.learning_cost?.experience_points) || 0) + ' XP';
        byId('skill-count').textContent = state.project.skills.length;
        byId('tree-count').textContent = new Set(state.project.skills.map(function (item) { return item.element_id; })).size;
        if (elementChanged) renderPrerequisites(skill);
        renderSkillList();
        renderInspector();
        renderTreeCanvas();
        renderSkillSummary(skill);
    }

    function createSkill(requirements, elementId, template, customName) {
        var name = customName || (template ? template.title : 'Nova skill');
        var parentPoints = requirements.map(function (id) {
            var parent = state.project.skills.find(function (skill) { return skill.id === id; });
            if (!parent) return null;
            return parent.element_id === elementId ? Model.position(state.project, parent, state.project.skills.indexOf(parent)) : null;
        }).filter(Boolean);
        var x = parentPoints.length ? Math.max.apply(null, parentPoints.map(function (point) { return point.x; })) + 270 : 80;
        var y = parentPoints.length ? parentPoints.reduce(function (sum, point) { return sum + point.y; }, 0) / parentPoints.length + 125 : 80;
        var skill = Model.makeSkill(state.project, name, elementId, requirements, template || null);
        // Input mínimo: o ID sai do nome, a descrição é escrita a partir do que
        // já foi escolhido e o resto fica com os valores por omissão.
        state.autoDescription[skill.id] = true;
        if (!skill.description) skill.description = Model.describeSkill(skill);
        state.project.skills.push(skill);
        Model.setPosition(state.project, skill, x, y);
        state.selectedSkillId = skill.id;
        state.elementFilter = 'all';
        byId('element-filter').value = 'all';
        state.prerequisiteSearch = '';
        state.prerequisiteSelection = new Set(requirements || []);
        byId('prerequisite-search').value = '';
        byId('quick-name').value = '';
        persist();
        renderAll();
        setView('skills');
        if (!customName) byId('skill-editor').elements.name.focus();
        else byId('skill-editor').elements.description.focus();
        toast(requirements.length
            ? 'Nova ramificação criada com ' + requirements.length + ' pré-requisito(s).'
            : template ? 'Skill criada a partir do modelo “' + template.title + '”.'
                : 'Skill criada: “' + skill.name + '”. Afina a descrição quando quiseres.');
    }

    function deleteSelectedSkill() {
        var skill = currentSkill();
        if (!skill) return;
        var usedBy = state.project.skills.filter(function (candidate) { return (candidate.learning_requirements?.required_attack_ids || []).includes(skill.id); });
        var message = 'Apagar "' + skill.name + '"?';
        if (usedBy.length) message += '\n\n' + usedBy.length + ' skill(s) ainda dependem dela; as referências serão assinaladas.';
        confirmAction(message, 'Apagar', 'Apagar skill').then(function (accepted) {
            if (!accepted) return;
            state.project.skills = state.project.skills.filter(function (candidate) { return candidate.id !== skill.id; });
            Object.values(state.project.trees).forEach(function (tree) { delete tree.positions[skill.id]; });
            state.selectedSkillId = state.project.skills[0]?.id || null;
            persist();
            renderAll();
            toast('Skill apagada.');
        });
    }

    function duplicateSelectedSkill() {
        var skill = currentSkill();
        if (!skill) return;
        var copy = Model.clone(skill);
        var baseId = Model.slug(skill.name) + '_copia';
        var id = baseId;
        var suffix = 2;
        while (state.project.skills.some(function (candidate) { return candidate.id === id; })) id = baseId + '_' + suffix++;
        copy.id = id;
        copy.name = skill.name + ' (cópia)';
        if (copy.effects?.length) {
            copy.effects.forEach(function (effect, index) {
                if (effect.effect_id) effect.effect_id = id + '_effect_' + (index + 1);
            });
        }
        state.project.skills.push(copy);
        var sourcePoint = Model.position(state.project, skill, state.project.skills.indexOf(skill));
        Model.setPosition(state.project, copy, sourcePoint.x + 40, sourcePoint.y + 130);
        state.selectedSkillId = copy.id;
        state.prerequisiteSelection = new Set(copy.learning_requirements?.required_attack_ids || []);
        persist();
        renderAll();
        setView('skills');
        toast('Skill duplicada como "' + copy.name + '".');
    }

    function defaultElement() {
        if (state.view === 'trees') return state.treeElement;
        return state.elementFilter !== 'all' ? state.elementFilter : (currentSkill()?.element_id || 'aqua');
    }

    function setZoom(next, anchor) {
        var canvas = byId('tree-canvas');
        var target = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100));
        if (target === state.zoom) return;
        var rect = canvas.getBoundingClientRect();
        var anchorX = anchor ? anchor.clientX - rect.left : canvas.clientWidth / 2;
        var anchorY = anchor ? anchor.clientY - rect.top : canvas.clientHeight / 2;
        var contentX = canvas.scrollLeft + anchorX;
        var contentY = canvas.scrollTop + anchorY;
        var factor = target / state.zoom;
        state.zoom = target;
        applyZoom();
        canvas.scrollLeft = contentX * factor - anchorX;
        canvas.scrollTop = contentY * factor - anchorY;
    }

    function applyZoom() {
        var nodes = byId('tree-nodes');
        var edges = byId('tree-edges');
        var canvas = byId('tree-canvas');
        var transform = 'scale(' + state.zoom + ')';
        nodes.style.transform = transform;
        edges.style.transform = transform;
        nodes.style.transformOrigin = '0 0';
        edges.style.transformOrigin = '0 0';
        canvas.style.backgroundSize = (23 * state.zoom) + 'px ' + (23 * state.zoom) + 'px';
        canvas.style.backgroundPosition = (11 * state.zoom) + 'px ' + (11 * state.zoom) + 'px';
        byId('zoom-level').textContent = Math.round(state.zoom * 100) + '%';
        byId('btn-zoom-out').disabled = state.zoom <= ZOOM_MIN;
        byId('btn-zoom-in').disabled = state.zoom >= ZOOM_MAX;
        void canvas.scrollWidth;
    }

    function fitTree() {
        var canvas = byId('tree-canvas');
        var layout = state.treeLayout;
        if (!layout || !layout.width) { setZoom(1); return; }
        setZoom(Math.min((canvas.clientWidth - 40) / layout.width, (canvas.clientHeight - 40) / layout.height));
        canvas.scrollLeft = 0;
        canvas.scrollTop = 0;
    }

    function startPan(event) {
        if (event.button !== 0) return;
        if (event.target.closest('[data-skill-node], button, input, label')) return;
        var canvas = byId('tree-canvas');
        state.pan = { x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
        canvas.classList.add('is-panning');
        event.preventDefault();
    }

    function movePan(event) {
        if (!state.pan) return;
        var canvas = byId('tree-canvas');
        canvas.scrollLeft = state.pan.left - (event.clientX - state.pan.x);
        canvas.scrollTop = state.pan.top - (event.clientY - state.pan.y);
    }

    function stopPan() {
        if (!state.pan) return;
        state.pan = null;
        byId('tree-canvas').classList.remove('is-panning');
    }

    function numberValue(value, fallback) {
        var parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    /** Escreve um número opcional: um campo vazio apaga a chave. */
    function setOptionalNumber(target, key, value) {
        if (value === '' || value === null || value === undefined) {
            delete target[key];
            return;
        }
        var parsed = Number(value);
        if (Number.isFinite(parsed)) target[key] = parsed;
    }

    /** Converte o texto de um campo: número quando dá, senão o texto tal e qual. */
    function fieldValue(raw) {
        if (raw === '' || raw === null || raw === undefined) return undefined;
        var parsed = Number(raw);
        if (Number.isFinite(parsed) && String(raw).trim() !== '') return parsed;
        return raw;
    }

    /** Lê um valor aninhado por caminho com pontos (`move.who`). */
    function readNested(source, path) {
        return String(path).split('.').reduce(function (node, part) {
            return node && typeof node === 'object' ? node[part] : undefined;
        }, source);
    }

    /** Escreve (ou apaga) um valor aninhado por caminho com pontos. */
    function setNested(target, path, value) {
        var parts = String(path).split('.');
        var node = target;
        parts.forEach(function (part, index) {
            if (index === parts.length - 1) {
                if (value === undefined) delete node[part];
                else node[part] = value;
            } else {
                if (!node[part] || typeof node[part] !== 'object') node[part] = {};
                node = node[part];
            }
        });
    }

    /** Limpa os objetos vazios que ficaram pelo caminho depois de apagar. */
    function pruneEmpty(target, path) {
        var parts = String(path).split('.');
        for (var index = parts.length - 1; index > 0; index -= 1) {
            var parentPath = parts.slice(0, index).join('.');
            var parent = readNested(target, parentPath);
            if (parent && typeof parent === 'object' && !Object.keys(parent).length) {
                setNested(target, parentPath, undefined);
            }
        }
    }

    function persist() {
        if (state.saveTimer) window.clearTimeout(state.saveTimer);
        byId('save-state').classList.add('is-saving');
        byId('save-state').innerHTML = '<i></i> A guardar…';
        state.saveTimer = window.setTimeout(function () {
            var saved = Model.save(state.project);
            byId('save-state').classList.remove('is-saving');
            byId('save-state').innerHTML = saved ? '<i></i> Guardado neste dispositivo' : '<i></i> Não foi possível guardar';
            state.saveTimer = null;
        }, 250);
    }

    function toast(message, warning) {
        var element = byId('toast');
        element.textContent = message;
        element.classList.toggle('is-warning', Boolean(warning));
        element.classList.add('is-visible');
        if (state.toastTimer) window.clearTimeout(state.toastTimer);
        state.toastTimer = window.setTimeout(function () { element.classList.remove('is-visible'); }, 4000);
    }

    function escapeImportHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function showImportError(detail) {
        var backdrop = byId('import-error-backdrop');
        var body = byId('import-error-body');
        if (!backdrop || !body) { toast((detail && detail.title) || 'Importação cancelada', true); return; }
        var title = (detail && detail.title) || 'Importação cancelada';
        byId('import-error-title').textContent = title;
        var issues = (detail && Array.isArray(detail.issues)) ? detail.issues : [{ message: detail && detail.message ? detail.message : String(detail) }];
        body.innerHTML = issues.map(function (issue) {
            var parts = [];
            if (issue.file) parts.push('<div class="issue-file">' + escapeImportHtml(issue.file) + '</div>');
            if (issue.line) {
                parts.push('<div class="issue-loc">Linha ' + escapeImportHtml(issue.line) + (issue.column ? ', coluna ' + escapeImportHtml(issue.column) : '') + '</div>');
            }
            parts.push('<p class="issue-message">' + escapeImportHtml(issue.message || '') + '</p>');
            if (issue.snippet) parts.push('<pre>' + escapeImportHtml(issue.snippet) + '</pre>');
            if (issue.path) parts.push('<div class="issue-path">' + escapeImportHtml(issue.path) + '</div>');
            return '<div class="import-error-issue">' + parts.join('') + '</div>';
        }).join('');
        backdrop.hidden = false;
    }

    function closeImportError() {
        var backdrop = byId('import-error-backdrop');
        if (backdrop) backdrop.hidden = true;
    }

    // Diálogo de confirmação dentro da própria página: o confirm() nativo pode não
    // aparecer (ou ser bloqueado) em browsers embebidos e, ao ser cancelado, não
    // dava qualquer feedback — a importação falhava "em silêncio".
    function confirmAction(message, okLabel, titleLabel) {
        return new Promise(function (resolve) {
            var backdrop = byId('confirm-backdrop');
            if (!backdrop) { resolve(window.confirm(message)); return; }
            byId('confirm-message').textContent = message;
            byId('confirm-title').textContent = titleLabel || 'Confirmar';
            byId('confirm-eyebrow').textContent = (titleLabel || 'Confirmar').toUpperCase();
            byId('btn-confirm-ok').textContent = okLabel || 'Confirmar';
            backdrop.hidden = false;
            function close(value) {
                backdrop.hidden = true;
                window.removeEventListener('keydown', onKey, true);
                byId('btn-confirm-ok').onclick = null;
                byId('btn-confirm-cancel').onclick = null;
                backdrop.onclick = null;
                resolve(value);
            }
            function onKey(event) {
                if (event.key === 'Escape') { event.preventDefault(); close(false); }
                else if (event.key === 'Enter') { event.preventDefault(); close(true); }
            }
            byId('btn-confirm-ok').onclick = function () { close(true); };
            byId('btn-confirm-cancel').onclick = function () { close(false); };
            backdrop.onclick = function (event) { if (event.target === backdrop) close(false); };
            window.addEventListener('keydown', onKey, true);
            byId('btn-confirm-ok').focus();
        });
    }

    function serializeSkill(skill) {
        var result = {
            id: skill.id,
            name: skill.name,
            description: skill.description || '',
            element_id: skill.element_id,
            learning_cost: { experience_points: Number(skill.learning_cost?.experience_points) || 0 },
            learning_requirements: { required_attack_ids: (skill.learning_requirements?.required_attack_ids || []).slice() },
        };
        if (skill.targeting) result.targeting = skill.targeting;
        if (skill.damage) result.damage = Model.clone(skill.damage);
        if (skill.accuracy !== undefined) result.accuracy = skill.accuracy;
        if (skill.hit_count !== undefined) result.hit_count = skill.hit_count;
        if (skill.solar) result.solar = true;
        if (skill.lunar) result.lunar = true;
        if (skill.only_during_day) result.only_during_day = true;
        if (skill.only_during_night) result.only_during_night = true;
        if (skill.ignore_accuracy) result.ignore_accuracy = true;
        if (skill.crit_chance !== undefined) result.crit_chance = skill.crit_chance;
        if (skill.defense_pierce !== undefined) result.defense_pierce = skill.defense_pierce;
        if (skill.flee_below_hp !== undefined) result.flee_below_hp = skill.flee_below_hp;
        if (skill.guaranteed_crit_vs_status) result.guaranteed_crit_vs_status = skill.guaranteed_crit_vs_status;
        if (skill.bonus_vs_hp_below) result.bonus_vs_hp_below = Model.clone(skill.bonus_vs_hp_below);
        if (skill.bonus_vs_status) result.bonus_vs_status = Model.clone(skill.bonus_vs_status);
        if (skill.bonus_per_charge) result.bonus_per_charge = Model.clone(skill.bonus_per_charge);
        if (skill.kind) result.kind = skill.kind;
        if (skill.sfx) result.sfx = skill.sfx;
        if (skill.recoil) result.recoil = Model.clone(skill.recoil);
        if (skill.friendly_fire) result.friendly_fire = Model.clone(skill.friendly_fire);
        if (skill.backlane_splash) result.backlane_splash = Model.clone(skill.backlane_splash);
        if (skill.no_space_recoil) result.no_space_recoil = Model.clone(skill.no_space_recoil);
        if (skill.chain) result.chain = Model.clone(skill.chain);
        if (skill.shrapnel) result.shrapnel = Model.clone(skill.shrapnel);
        if (skill.instability) result.instability = Model.clone(skill.instability);
        if (Number(skill.control_immune_damage) > 0) result.control_immune_damage = Number(skill.control_immune_damage);
        if (skill.on_kill_detonation) result.on_kill_detonation = Model.clone(skill.on_kill_detonation);
        if (skill.cooldown_reset) result.cooldown_reset = Model.clone(skill.cooldown_reset);
        if (skill.damage_taken_scaling) result.damage_taken_scaling = Model.clone(skill.damage_taken_scaling);
        if (skill.element_effectiveness) result.element_effectiveness = Model.clone(skill.element_effectiveness);
        if (skill.consume_stacks) result.consume_stacks = Model.clone(skill.consume_stacks);
        if (skill.bonus_vs_elements && Object.keys(skill.bonus_vs_elements).length) {
            result.bonus_vs_elements = Model.clone(skill.bonus_vs_elements);
        }
        result.costs = {
            mana: Number(skill.costs?.mana) || 0,
            stamina: Number(skill.costs?.stamina) || 0,
            cooldown: Number(skill.costs?.cooldown) || 0,
        };
        if (Number(skill.costs?.hp)) result.costs.hp = Number(skill.costs.hp);
        if (skill.effects?.length) result.effects = skill.effects.map(Model.cleanEffect).filter(Boolean);
        if (skill.collateral) result.collateral = Model.clone(skill.collateral);
        return result;
    }

    function skillsYaml() {
        var skills = sortedSkills(state.project.skills).map(serializeSkill);
        var indexLines = ['# Índice de skills (elemento → IDs):'];
        var currentElement = null;
        skills.forEach(function (skill) {
            if (skill.element_id !== currentElement) {
                currentElement = skill.element_id;
                indexLines.push('# ' + currentElement);
            }
            indexLines.push('#   ' + skill.id);
        });
        var yamlText = dumpYaml({ skills: skills });
        return indexLines.join('\n') + '\n' + yamlText;
    }

    function exportPackage() {
        var report = Model.validate(state.project);
        if (report.errors.length) {
            renderInspector();
            toast('Corrige os erros indicados antes de exportar o YAML.', true);
            return;
        }
        try {
            downloadFile('skills.yaml', skillsYaml(), 'text/yaml;charset=utf-8');
            toast('skills.yaml exportado — coloca-o em apps/desktop/src/data/combat/skills/.');
        } catch (error) {
            toast('Falha ao exportar o YAML: ' + error.message, true);
        }
    }

    function dumpYaml(value) {
        return root.jsyaml ? root.jsyaml.dump(value, { noRefs: true, lineWidth: 110, sortKeys: false }) : JSON.stringify(value, null, 2);
    }

    function downloadFile(name, text, type) {
        downloadBlob(name, new Blob([text], { type: type }));
    }

    function downloadBlob(name, blob) {
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    }

    function buildSnippet(text, line, column) {
        var lines = String(text || '').split('\\n');
        var start = Math.max(0, (line || 0) - 2);
        var end = Math.min(lines.length, (line || 0) + 2);
        var out = [];
        for (var i = start; i < end; i++) {
            out.push((i + 1) + ' | ' + lines[i]);
            if (i === (line || 0)) {
                var caret = '   ';
                for (var c = 0; c < (column || 0); c++) caret += ' ';
                caret += '^';
                out.push(caret);
            }
        }
        return out.join('\\n');
    }

    function makeParseError(file, error, text) {
        var issue = { file: file.name, message: (error && error.reason) ? error.reason : (error && error.message ? error.message : String(error)) };
        if (error && error.mark) {
            issue.line = (error.mark.line || 0) + 1;
            issue.column = (error.mark.column || 0) + 1;
            issue.snippet = buildSnippet(text, error.mark.line || 0, error.mark.column || 0);
        } else if (error && typeof error.lineNumber === 'number') {
            issue.line = error.lineNumber;
            issue.snippet = buildSnippet(text, error.lineNumber - 1, 0);
        }
        return issue;
    }

    function readFile(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () {
                try {
                    var text = String(reader.result || '');
                    var value = parseContent(text);
                    resolve({ file: file, value: value, text: text });
                } catch (error) { reject(makeParseError(file, error, text)); }
            };
            reader.onerror = function () { reject({ file: file.name, message: 'Falha ao ler ' + file.name }); };
            reader.readAsText(file);
        });
    }

    function parseContent(text) {
        return root.jsyaml
            ? root.jsyaml.load(text)
            : JSON.parse(text.split('\n').filter(function (line) { return !line.trim().startsWith('#'); }).join('\n'));
    }

    function importFiles(event) {
        var files = Array.from(event.target.files || []);
        event.target.value = '';
        if (!files.length) return;
        Promise.allSettled(files.map(readFile)).then(function (results) {
            var parseErrors = [];
            var entries = [];
            results.forEach(function (result) {
                if (result.status === 'fulfilled') entries.push(result.value);
                else parseErrors.push(result.reason);
            });
            if (parseErrors.length) {
                showImportError({ title: 'Não foi possível ler o(s) ficheiro(s)', issues: parseErrors });
                return;
            }
            return importEntries(entries);
        }).catch(function (error) {
            if (error && Array.isArray(error.issues)) {
                showImportError({ title: 'Importação cancelada', issues: error.issues });
            } else {
                showImportError({ title: 'Importação cancelada', issues: [{ message: error && error.message ? error.message : String(error) }] });
            }
        });
    }

    function importEntries(entries) {
        return Promise.resolve().then(function () {
            var catalogEntry = entries.find(function (entry) { return entry.value && Array.isArray(entry.value.skills); });
            if (!catalogEntry) {
                var err = new Error('O ficheiro precisa de conter uma lista “skills”.');
                err.issues = [{ message: 'Nenhum dos ficheiros selecionados contém uma lista “skills”. Verifica se o YAML tem a chave “skills:”.' }];
                throw err;
            }
            var rawSkills = catalogEntry.value.skills;
            var skipped = 0;
            var skills = rawSkills.map(function (source, index) {
                var normalized = Model.normalizeSkill(source);
                if (!normalized) { skipped++; return null; }
                normalized.__index = index;
                return normalized;
            }).filter(Boolean);
            var issues = [];
            if (skipped) {
                issues.push({ message: skipped + ' skill(s) foram ignoradas por falta de “id” ou “name”. Cada skill precisa de id e name.' });
            }
            var duplicateIds = findDuplicates(skills.map(function (skill) { return skill.id; }));
            duplicateIds.forEach(function (id) {
                issues.push({ message: 'ID de skill duplicado: ' + id, path: 'skills.' + id + '.id' });
            });
            var knownIds = new Set(skills.map(function (skill) { return skill.id; }));
            skills.forEach(function (skill) {
                (skill.learning_requirements.required_attack_ids || []).forEach(function (id) {
                    if (!knownIds.has(id)) {
                        issues.push({ message: skill.id + ' exige a skill não importada “' + id + '”.', path: 'skills.' + skill.id + '.learning_requirements.required_attack_ids' });
                    }
                });
            });
            if (issues.length) {
                var err = new Error(issues[0].message);
                err.issues = issues;
                throw err;
            }
            // As árvores são derivadas do catálogo: pertença por element_id e
            // arestas por learning_requirements (o normalize cria as posições).
            var imported = Model.normalize({ skills: skills });
            var report = Model.validate(imported);
            if (report.errors.length) {
                var vIssues = report.errors.map(function (issue) {
                    return { message: issue.message, path: issue.path };
                });
                var verr = new Error(report.errors[0].message);
                verr.issues = vIssues;
                throw verr;
            }
            // avisos não bloqueiam, mas mostra-os? Manter toast curto.
            return confirmAction('Importar ' + skills.length
                + ' skill(s), substituindo o rascunho local?', 'Importar', 'Importar YAML').then(function (accepted) {
                if (!accepted) { toast('Importação cancelada — o rascunho local mantém-se.'); return; }
                state.project = imported;
                state.treeElement = skills[0]?.element_id || 'aqua';
                state.selectedSkillId = skills[0]?.id || null;
                state.openScopes = Object.create(null);
                byId('tree-element').value = state.treeElement;
                persist();
                renderAll();
                toast('YAML importado: ' + skills.length + ' skill(s) — as árvores foram derivadas dos elementos e pré-requisitos.');
                if (report.warnings && report.warnings.length) {
                    toast(report.warnings.length + ' aviso(s) na importação — vê o painel de validação.', true);
                }
            });
        });
    }

    function findDuplicates(values) {
        var seen = new Set();
        var duplicates = new Set();
        values.forEach(function (value) { if (seen.has(value)) duplicates.add(value); else seen.add(value); });
        return Array.from(duplicates);
    }

    document.addEventListener('DOMContentLoaded', boot);
})(window);
