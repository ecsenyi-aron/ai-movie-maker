export type ProjectMode = "stock" | "premium";

export type ProjectStatus =
  | "draft"
  | "planning"
  | "awaiting_approval"
  | "approved"
  | "generating"
  | "preview_ready"
  | "failed";

export type ShotStatus =
  | "planned"
  | "audio_ready"
  | "clip_ready"
  | "qc_ok"
  | "needs_review";

export type GenerationStep =
  | "reference_image"
  | "video"
  | "lipsync"
  | "stock"
  | "tts";

export type JobStatus =
  | "pending"
  | "submitted"
  | "processing"
  | "succeeded"
  | "failed"
  | "cancelled";

export type MediaType = "audio" | "video" | "image" | "subtitle";

export type Database = {
  public: {
    Tables: {
      projects: {
        Row: {
          id: string;
          user_id: string;
          title: string;
          premise: string;
          genre: string | null;
          budget_usd: number;
          mode: ProjectMode;
          lipsync: boolean;
          status: ProjectStatus;
          approved_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          title?: string;
          premise?: string;
          genre?: string | null;
          budget_usd?: number;
          mode?: ProjectMode;
          lipsync?: boolean;
          status?: ProjectStatus;
          approved_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["projects"]["Insert"]>;
        Relationships: [];
      };
      screenplays: {
        Row: {
          id: string;
          project_id: string;
          content: string;
          version: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          content?: string;
          version?: number;
        };
        Update: Partial<Database["public"]["Tables"]["screenplays"]["Insert"]>;
        Relationships: [];
      };
      characters: {
        Row: {
          id: string;
          project_id: string;
          stable_id: string;
          name: string;
          canonical_description: string;
          continuity: Record<string, unknown>;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          stable_id: string;
          name: string;
          canonical_description?: string;
          continuity?: Record<string, unknown>;
        };
        Update: Partial<Database["public"]["Tables"]["characters"]["Insert"]>;
        Relationships: [];
      };
      locations: {
        Row: {
          id: string;
          project_id: string;
          stable_id: string;
          name: string;
          canonical_description: string;
          continuity: Record<string, unknown>;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          stable_id: string;
          name: string;
          canonical_description?: string;
          continuity?: Record<string, unknown>;
        };
        Update: Partial<Database["public"]["Tables"]["locations"]["Insert"]>;
        Relationships: [];
      };
      scenes: {
        Row: {
          id: string;
          project_id: string;
          number: number;
          title: string;
          description: string;
          location_id: string | null;
          time_of_day: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          number: number;
          title?: string;
          description?: string;
          location_id?: string | null;
          time_of_day?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["scenes"]["Insert"]>;
        Relationships: [];
      };
      shots: {
        Row: {
          id: string;
          scene_id: string;
          number: number;
          camera_angle: string | null;
          camera_movement: string | null;
          action: string;
          dialogue_hu: string | null;
          visual_prompt_en: string;
          target_duration_sec: number | null;
          actual_duration_sec: number | null;
          duration_estimated: boolean;
          estimated_cost_usd: number;
          actual_cost_usd: number;
          status: ShotStatus;
          qc_notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          scene_id: string;
          number: number;
          camera_angle?: string | null;
          camera_movement?: string | null;
          action?: string;
          dialogue_hu?: string | null;
          visual_prompt_en?: string;
          target_duration_sec?: number | null;
          actual_duration_sec?: number | null;
          duration_estimated?: boolean;
          estimated_cost_usd?: number;
          actual_cost_usd?: number;
          status?: ShotStatus;
          qc_notes?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["shots"]["Insert"]>;
        Relationships: [];
      };
      generation_jobs: {
        Row: {
          id: string;
          project_id: string;
          shot_id: string | null;
          provider: string;
          step: GenerationStep;
          attempt: number;
          prompt: string | null;
          provider_job_id: string | null;
          status: JobStatus;
          estimated_cost_usd: number;
          reserved_cost_usd: number;
          actual_cost_usd: number;
          error: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          shot_id?: string | null;
          provider: string;
          step: GenerationStep;
          attempt?: number;
          prompt?: string | null;
          provider_job_id?: string | null;
          status?: JobStatus;
          estimated_cost_usd?: number;
          reserved_cost_usd?: number;
          actual_cost_usd?: number;
          error?: string | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["generation_jobs"]["Insert"]
        >;
        Relationships: [];
      };
      utterances: {
        Row: {
          id: string;
          project_id: string;
          character_id: string | null;
          source_shot_id: string | null;
          text_hu: string;
          delivery_style: string;
          voice_settings: Record<string, unknown>;
          audio_path: string | null;
          measured_duration_seconds: number | null;
          duration_estimated: boolean;
          version: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          character_id?: string | null;
          source_shot_id?: string | null;
          text_hu: string;
          delivery_style?: string;
          voice_settings?: Record<string, unknown>;
          audio_path?: string | null;
          measured_duration_seconds?: number | null;
          duration_estimated?: boolean;
          version?: number;
        };
        Update: Partial<Database["public"]["Tables"]["utterances"]["Insert"]>;
        Relationships: [];
      };
      timeline_items: {
        Row: {
          id: string;
          project_id: string;
          track: "video" | "audio" | "subtitle";
          shot_id: string | null;
          media_asset_id: string | null;
          utterance_id: string | null;
          start_seconds: number;
          source_in: number | null;
          source_out: number | null;
          duration_seconds: number | null;
          trim_reserve_seconds: number | null;
          sequence_order: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          track: "video" | "audio" | "subtitle";
          shot_id?: string | null;
          media_asset_id?: string | null;
          utterance_id?: string | null;
          start_seconds?: number;
          source_in?: number | null;
          source_out?: number | null;
          duration_seconds?: number | null;
          trim_reserve_seconds?: number | null;
          sequence_order?: number;
        };
        Update: Partial<Database["public"]["Tables"]["timeline_items"]["Insert"]>;
        Relationships: [];
      };
      media_assets: {
        Row: {
          id: string;
          project_id: string;
          shot_id: string | null;
          type: MediaType;
          storage_path: string;
          public_url: string | null;
          duration_sec: number | null;
          provider: string | null;
          attribution: string | null;
          lipsync_applied: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          shot_id?: string | null;
          type: MediaType;
          storage_path: string;
          public_url?: string | null;
          duration_sec?: number | null;
          provider?: string | null;
          attribution?: string | null;
          lipsync_applied?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["media_assets"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      is_project_owner: {
        Args: { p_project_id: string };
        Returns: boolean;
      };
      is_scene_owner: {
        Args: { p_scene_id: string };
        Returns: boolean;
      };
      is_shot_owner: {
        Args: { p_shot_id: string };
        Returns: boolean;
      };
    };
    Enums: {
      project_mode: ProjectMode;
      project_status: ProjectStatus;
      shot_status: ShotStatus;
      generation_step: GenerationStep;
      job_status: JobStatus;
      media_type: MediaType;
    };
    CompositeTypes: Record<string, never>;
  };
};
