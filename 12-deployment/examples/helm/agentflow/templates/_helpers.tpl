{{/*
通用 helper 模板
*/}}

{{/* 应用名 */}}
{{- define "agentflow.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* fullname：chart 名 + release 名 */}}
{{- define "agentflow.fullname" -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* 通用 labels */}}
{{- define "agentflow.labels" -}}
app.kubernetes.io/name: {{ include "agentflow.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* 镜像全路径 */}}
{{- define "agentflow.image" -}}
{{- $registry := .Values.global.imageRegistry -}}
{{- $repo := .Values.image.repository -}}
{{- $name := .name -}}
{{- $tag := .Values.image.tag -}}
{{- printf "%s/%s/%s:%s" $registry $repo $name $tag -}}
{{- end -}}
