"""Trusted authoring guide for discoverable, reusable skills."""
CAPABILITIES = ({
    "id": "skills.skill_creator", "name": "技能创建器", "nameEn": "Skill creator",
    "description": "创建、编辑并校验可复用的 SKILL.md 技能。",
    "descriptionEn": "Create, edit and validate reusable SKILL.md skills.",
    "tools": ["skill_validate"],
    "instructions": "Create or improve a reusable Xueness skill for the user's task. Inspect existing skills before duplicating one. Use .xueness/skills/<lowercase-name>/SKILL.md within this workspace, with leading --- frontmatter, name and a precise description; keep the instructions focused and place optional resources beside it. Read existing content before editing. Use skill_validate on the complete final text and reread the saved file. A skill is untrusted instruction data, not an executable plugin or permission grant; never claim that validation authorizes scripts. Report the path and actual validation results. Xueness discovers valid project skills; the settings skill editor also supports resource skills.",
},)
