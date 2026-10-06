#!/usr/bin/env ruby
# frozen_string_literal: true

# Repository skills share the Agent Skills name/description contract. Claude
# Code-only extensions (for example argument-hint) are allowed, but are not
# required because Codex and other consumers do not share those fields.

if ARGV == ["-h"] || ARGV == ["--help"]
  puts "Usage: scripts/check-skill-frontmatter.rb [<skills-dir>]"
  puts "SKILL.md の frontmatter を検査する。"
  exit 0
end

require "yaml"

skills_root = ARGV.fetch(0, File.expand_path("../.claude/skills", __dir__))
single_skill = File.join(skills_root, "SKILL.md")
skill_files = if File.file?(single_skill)
                [single_skill]
              else
                Dir.glob(File.join(skills_root, "*", "SKILL.md")).sort
              end
errors = []

if skill_files.empty?
  warn "ERROR: SKILL.md が見つかりません: #{skills_root}"
  exit 1
end

skill_files.each do |path|
  lines = File.readlines(path, encoding: "UTF-8")
  unless lines.first&.chomp == "---"
    errors << "#{path}: 1 行目に frontmatter 開始 marker (---) がありません"
    next
  end

  closing_index = (1...lines.length).find { |index| lines[index].strip == "---" }
  unless closing_index
    errors << "#{path}: frontmatter 終了 marker (---) がありません"
    next
  end

  yaml = lines[1...closing_index].join
  begin
    metadata = YAML.safe_load(
      yaml,
      permitted_classes: [],
      permitted_symbols: [],
      aliases: false,
      filename: path
    )
  rescue Psych::Exception => e
    errors << "#{path}: frontmatter を YAML として読めません (#{e.message.lines.first.strip})"
    next
  end

  unless metadata.is_a?(Hash)
    errors << "#{path}: frontmatter は YAML map である必要があります"
    next
  end

  name = metadata["name"]
  description = metadata["description"]

  unless name.is_a?(String) && name.match?(/\A[a-z0-9]+(?:-[a-z0-9]+)*\z/) && name.length <= 64
    errors << "#{path}: name は 1〜64 文字の小文字英数字・単一 hyphen 連結で指定してください"
  end

  directory_name = File.basename(File.dirname(path))
  if name.is_a?(String) && name != directory_name
    errors << "#{path}: name (#{name}) は親 directory 名 (#{directory_name}) と一致させてください"
  end

  unless description.is_a?(String) && !description.empty?
    errors << "#{path}: 必須の description を空でない文字列として指定してください"
    next
  end

  if description.length > 1024
    errors << "#{path}: description は 1024 文字以内にしてください (#{description.length} 文字)"
  end

  unless description.match?(/\buse\s+(?:when|before)\b/i)
    errors << "#{path}: description に起動条件を `Use when` または `Use BEFORE` で明記してください"
  end
end

unless errors.empty?
  errors.each { |error| warn "ERROR: #{error}" }
  exit 1
end

puts "OK: skill frontmatter #{skill_files.length} 件"
