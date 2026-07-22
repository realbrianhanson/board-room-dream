export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      alerts: {
        Row: {
          cohort_id: string | null
          created_at: string
          detail: Json | null
          id: string
          kind: string
          project_id: string | null
          resolved_at: string | null
          snoozed_until: string | null
          status: string
          user_id: string
        }
        Insert: {
          cohort_id?: string | null
          created_at?: string
          detail?: Json | null
          id?: string
          kind: string
          project_id?: string | null
          resolved_at?: string | null
          snoozed_until?: string | null
          status?: string
          user_id: string
        }
        Update: {
          cohort_id?: string | null
          created_at?: string
          detail?: Json | null
          id?: string
          kind?: string
          project_id?: string | null
          resolved_at?: string | null
          snoozed_until?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "alerts_cohort_id_fkey"
            columns: ["cohort_id"]
            isOneToOne: false
            referencedRelation: "cohorts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alerts_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      api_keys: {
        Row: {
          created_at: string
          encrypted_key: string
          id: string
          last4: string | null
          provider: string
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          encrypted_key: string
          id?: string
          last4?: string | null
          provider: string
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          encrypted_key?: string
          id?: string
          last4?: string | null
          provider?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          key: string
          updated_at: string
          value: Json
          version: number
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
          version?: number
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
          version?: number
        }
        Relationships: []
      }
      audit_findings: {
        Row: {
          audit_id: string
          created_at: string
          description: string | null
          file_path: string | null
          fix_batch_id: string | null
          id: string
          seat: string | null
          severity: string
          status: string
          title: string
          user_id: string
        }
        Insert: {
          audit_id: string
          created_at?: string
          description?: string | null
          file_path?: string | null
          fix_batch_id?: string | null
          id?: string
          seat?: string | null
          severity: string
          status?: string
          title: string
          user_id: string
        }
        Update: {
          audit_id?: string
          created_at?: string
          description?: string | null
          file_path?: string | null
          fix_batch_id?: string | null
          id?: string
          seat?: string | null
          severity?: string
          status?: string
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_findings_audit_id_fkey"
            columns: ["audit_id"]
            isOneToOne: false
            referencedRelation: "audits"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_findings_fix_batch_id_fkey"
            columns: ["fix_batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
        ]
      }
      audits: {
        Row: {
          base_sha: string | null
          batch_id: string | null
          completed_at: string | null
          created_at: string
          files_analyzed: number | null
          head_sha: string | null
          id: string
          kind: string
          loop_no: number
          project_id: string
          run_id: string | null
          source: string | null
          status: string
          summary: Json | null
          user_id: string
        }
        Insert: {
          base_sha?: string | null
          batch_id?: string | null
          completed_at?: string | null
          created_at?: string
          files_analyzed?: number | null
          head_sha?: string | null
          id?: string
          kind: string
          loop_no?: number
          project_id: string
          run_id?: string | null
          source?: string | null
          status?: string
          summary?: Json | null
          user_id: string
        }
        Update: {
          base_sha?: string | null
          batch_id?: string | null
          completed_at?: string | null
          created_at?: string
          files_analyzed?: number | null
          head_sha?: string | null
          id?: string
          kind?: string
          loop_no?: number
          project_id?: string
          run_id?: string | null
          source?: string | null
          status?: string
          summary?: Json | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audits_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audits_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audits_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "boardroom_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      batch_generation_archives: {
        Row: {
          batches_json: Json
          created_at: string
          id: string
          project_id: string
          source_run_id: string | null
          user_id: string
        }
        Insert: {
          batches_json: Json
          created_at?: string
          id?: string
          project_id: string
          source_run_id?: string | null
          user_id: string
        }
        Update: {
          batches_json?: Json
          created_at?: string
          id?: string
          project_id?: string
          source_run_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "batch_generation_archives_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "batch_generation_archives_source_run_id_fkey"
            columns: ["source_run_id"]
            isOneToOne: false
            referencedRelation: "boardroom_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      batches: {
        Row: {
          batch_no: number
          built_at: string | null
          channel: string
          compile_meta: Json | null
          compiled_at: string | null
          compiled_prompt_md: string | null
          compiled_verification_prompt_md: string | null
          created_at: string
          id: string
          is_fix: boolean
          outcome_md: string | null
          parent_batch_id: string | null
          plan_version_id: string | null
          project_id: string
          prompt_md: string
          sent_at: string | null
          status: string
          title: string
          user_id: string
        }
        Insert: {
          batch_no: number
          built_at?: string | null
          channel?: string
          compile_meta?: Json | null
          compiled_at?: string | null
          compiled_prompt_md?: string | null
          compiled_verification_prompt_md?: string | null
          created_at?: string
          id?: string
          is_fix?: boolean
          outcome_md?: string | null
          parent_batch_id?: string | null
          plan_version_id?: string | null
          project_id: string
          prompt_md: string
          sent_at?: string | null
          status?: string
          title: string
          user_id: string
        }
        Update: {
          batch_no?: number
          built_at?: string | null
          channel?: string
          compile_meta?: Json | null
          compiled_at?: string | null
          compiled_prompt_md?: string | null
          compiled_verification_prompt_md?: string | null
          created_at?: string
          id?: string
          is_fix?: boolean
          outcome_md?: string | null
          parent_batch_id?: string | null
          plan_version_id?: string | null
          project_id?: string
          prompt_md?: string
          sent_at?: string | null
          status?: string
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "batches_parent_batch_id_fkey"
            columns: ["parent_batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "batches_plan_version_id_fkey"
            columns: ["plan_version_id"]
            isOneToOne: false
            referencedRelation: "plan_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "batches_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      boardroom_runs: {
        Row: {
          budget_usd: number
          budget_warning: boolean
          consensus: Json | null
          constitution_version: number | null
          created_at: string
          dissent_ledger: Json | null
          error: string | null
          founder_notes: string | null
          id: string
          kind: string
          loop_no: number
          project_id: string
          round_no: number
          spent_usd: number
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          budget_usd?: number
          budget_warning?: boolean
          consensus?: Json | null
          constitution_version?: number | null
          created_at?: string
          dissent_ledger?: Json | null
          error?: string | null
          founder_notes?: string | null
          id?: string
          kind: string
          loop_no?: number
          project_id: string
          round_no?: number
          spent_usd?: number
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          budget_usd?: number
          budget_warning?: boolean
          consensus?: Json | null
          constitution_version?: number | null
          created_at?: string
          dissent_ledger?: Json | null
          error?: string | null
          founder_notes?: string | null
          id?: string
          kind?: string
          loop_no?: number
          project_id?: string
          round_no?: number
          spent_usd?: number
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "boardroom_runs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      change_requests: {
        Row: {
          board_verdict: Json | null
          created_at: string
          description: string
          id: string
          plan_version_id: string | null
          project_id: string
          run_id: string | null
          status: string
          user_id: string
        }
        Insert: {
          board_verdict?: Json | null
          created_at?: string
          description: string
          id?: string
          plan_version_id?: string | null
          project_id: string
          run_id?: string | null
          status?: string
          user_id: string
        }
        Update: {
          board_verdict?: Json | null
          created_at?: string
          description?: string
          id?: string
          plan_version_id?: string | null
          project_id?: string
          run_id?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "change_requests_plan_version_id_fkey"
            columns: ["plan_version_id"]
            isOneToOne: false
            referencedRelation: "plan_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "change_requests_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "change_requests_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "boardroom_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      cohorts: {
        Row: {
          consensus_threshold: number | null
          daily_cap_usd: number | null
          id: string
          instructor_id: string | null
          join_code: string
          name: string
          starts_at: string | null
        }
        Insert: {
          consensus_threshold?: number | null
          daily_cap_usd?: number | null
          id?: string
          instructor_id?: string | null
          join_code: string
          name: string
          starts_at?: string | null
        }
        Update: {
          consensus_threshold?: number | null
          daily_cap_usd?: number | null
          id?: string
          instructor_id?: string | null
          join_code?: string
          name?: string
          starts_at?: string | null
        }
        Relationships: []
      }
      cost_ledger: {
        Row: {
          cost_usd: number
          created_at: string
          id: string
          model_id: string | null
          project_id: string | null
          run_id: string | null
          seat: string | null
          tokens_in: number
          tokens_out: number
          user_id: string
        }
        Insert: {
          cost_usd?: number
          created_at?: string
          id?: string
          model_id?: string | null
          project_id?: string | null
          run_id?: string | null
          seat?: string | null
          tokens_in?: number
          tokens_out?: number
          user_id: string
        }
        Update: {
          cost_usd?: number
          created_at?: string
          id?: string
          model_id?: string | null
          project_id?: string | null
          run_id?: string | null
          seat?: string | null
          tokens_in?: number
          tokens_out?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cost_ledger_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_ledger_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "boardroom_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      field_manual_proposals: {
        Row: {
          created_at: string
          created_by: string | null
          decided_at: string | null
          evidence: Json | null
          id: string
          proposed_rule: string
          rationale: string | null
          status: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          decided_at?: string | null
          evidence?: Json | null
          id?: string
          proposed_rule: string
          rationale?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          decided_at?: string | null
          evidence?: Json | null
          id?: string
          proposed_rule?: string
          rationale?: string | null
          status?: string
        }
        Relationships: []
      }
      intakes: {
        Row: {
          answers: Json
          created_at: string
          id: string
          project_id: string
          user_id: string
          validation_scores: Json | null
          verdict: string | null
        }
        Insert: {
          answers?: Json
          created_at?: string
          id?: string
          project_id: string
          user_id: string
          validation_scores?: Json | null
          verdict?: string | null
        }
        Update: {
          answers?: Json
          created_at?: string
          id?: string
          project_id?: string
          user_id?: string
          validation_scores?: Json | null
          verdict?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "intakes_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      model_registry: {
        Row: {
          display_name: string | null
          enabled: boolean
          fallback_model_id: string | null
          max_cost_per_run: number
          model_id: string
          role_prompt: string | null
          seat: string
          updated_at: string
          use_latest_alias: boolean
        }
        Insert: {
          display_name?: string | null
          enabled?: boolean
          fallback_model_id?: string | null
          max_cost_per_run?: number
          model_id: string
          role_prompt?: string | null
          seat: string
          updated_at?: string
          use_latest_alias?: boolean
        }
        Update: {
          display_name?: string | null
          enabled?: boolean
          fallback_model_id?: string | null
          max_cost_per_run?: number
          model_id?: string
          role_prompt?: string | null
          seat?: string
          updated_at?: string
          use_latest_alias?: boolean
        }
        Relationships: []
      }
      plan_versions: {
        Row: {
          content_md: string
          decision_log: Json | null
          dissent_ledger: Json | null
          features: Json | null
          id: string
          is_chair_ruled: boolean
          kind: string
          locked_at: string
          prd_md: string | null
          project_id: string
          source_run_id: string | null
          user_id: string
          version: number
        }
        Insert: {
          content_md: string
          decision_log?: Json | null
          dissent_ledger?: Json | null
          features?: Json | null
          id?: string
          is_chair_ruled?: boolean
          kind?: string
          locked_at?: string
          prd_md?: string | null
          project_id: string
          source_run_id?: string | null
          user_id: string
          version: number
        }
        Update: {
          content_md?: string
          decision_log?: Json | null
          dissent_ledger?: Json | null
          features?: Json | null
          id?: string
          is_chair_ruled?: boolean
          kind?: string
          locked_at?: string
          prd_md?: string | null
          project_id?: string
          source_run_id?: string | null
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "plan_versions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_versions_source_run_id_fkey"
            columns: ["source_run_id"]
            isOneToOne: false
            referencedRelation: "boardroom_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          cohort_id: string | null
          display_name: string | null
          id: string
          onboarded_at: string
          role: string
        }
        Insert: {
          cohort_id?: string | null
          display_name?: string | null
          id: string
          onboarded_at?: string
          role?: string
        }
        Update: {
          cohort_id?: string | null
          display_name?: string | null
          id?: string
          onboarded_at?: string
          role?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          created_at: string
          current_batch_no: number
          github_repo: string | null
          id: string
          is_import: boolean
          lovable_project_url: string | null
          name: string
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          current_batch_no?: number
          github_repo?: string | null
          id?: string
          is_import?: boolean
          lovable_project_url?: string | null
          name: string
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          current_batch_no?: number
          github_repo?: string | null
          id?: string
          is_import?: boolean
          lovable_project_url?: string | null
          name?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      run_steps: {
        Row: {
          completed_at: string | null
          cost_usd: number
          created_at: string
          error: string | null
          id: string
          request: Json | null
          response_json: Json | null
          response_text: string | null
          round: number
          run_id: string
          seat: string
          started_at: string | null
          status: string
          step_key: string
          tokens_in: number
          tokens_out: number
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          cost_usd?: number
          created_at?: string
          error?: string | null
          id?: string
          request?: Json | null
          response_json?: Json | null
          response_text?: string | null
          round: number
          run_id: string
          seat: string
          started_at?: string | null
          status?: string
          step_key: string
          tokens_in?: number
          tokens_out?: number
          user_id: string
        }
        Update: {
          completed_at?: string | null
          cost_usd?: number
          created_at?: string
          error?: string | null
          id?: string
          request?: Json | null
          response_json?: Json | null
          response_text?: string | null
          round?: number
          run_id?: string
          seat?: string
          started_at?: string | null
          status?: string
          step_key?: string
          tokens_in?: number
          tokens_out?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_steps_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "boardroom_runs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      model_registry_public: {
        Row: {
          display_name: string | null
          enabled: boolean | null
          model_id: string | null
          seat: string | null
        }
        Insert: {
          display_name?: string | null
          enabled?: boolean | null
          model_id?: string | null
          seat?: string | null
        }
        Update: {
          display_name?: string | null
          enabled?: boolean | null
          model_id?: string | null
          seat?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      admin_model_registry: {
        Args: never
        Returns: {
          display_name: string | null
          enabled: boolean
          fallback_model_id: string | null
          max_cost_per_run: number
          model_id: string
          role_prompt: string | null
          seat: string
          updated_at: string
          use_latest_alias: boolean
        }[]
        SetofOptions: {
          from: "*"
          to: "model_registry"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_compiler_schema_inventory: { Args: never; Returns: Json }
      join_cohort: { Args: { code: string }; Returns: string }
      record_model_call_atomic: {
        Args: {
          p_cost_usd: number
          p_model_id: string
          p_project_id: string
          p_run_id: string
          p_seat: string
          p_tokens_in: number
          p_tokens_out: number
          p_user_id: string
        }
        Returns: number
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
