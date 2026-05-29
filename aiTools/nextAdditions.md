

- Always keep a document of decision making history. 

Update preferences to specify:
- unless otherwise specified, always plan on building a UI for the app and it will use always use react and typescript
- unless otherwise specified, always use AWS for cloud infrastructure (ok to suggest other cloud hosts if they will be more optimal)

Scalability rules for all portions of the app
- server
- cloud 
- models
- frontend
- databases
- total app architecture
--- add anywhere else you can think of

For anything that uses llms
- we need to include adversarial safety & protect against any nefarious uses
--- consult with me on standard enterprise level practices here

Monitoring
- always plan to have grafana etc built in
- always build with statuses for maximum observability
- always include lots of obvservability within ai generation

Confidence
- always plan to build ai generations that have extremely high confidence
- assume we will make our own QA steps to ensure confidence

Cost per task
- always include cost tracking throughout ai uses 
- include cost tracking or tracking of any other points in the app that might incur significant costs (either early on or at scale) 

When making anything involving AI, always include Reproducibility & Replayability

Prompt tuning
- always use prompt versioning
--- add any other best practices or ideas for prompt tuning


When doing anything involving AI generation:
- always start with at least one example of a generation that is either correct or of top quality
- prefer many
- use correct examples during AI generation
  - consult me during planning to decide what stages of AI generation should use correct examples
  - make ability to toggle usage of correct/high-quality generation examples at all AI generation steps  
- plan to keep records to better train our own model off of the data we learn
  - record results of all generation steps
  - create 'correction' AI capability to suggest corrections for failed generations
    - have QA phase to review correctionsd
    - auto approve if confidence level is very high between both correction and QA agents
      - require admin approval otherwise
    - record approved corrections along with the failed generations 
  - set up to use all of this to eventually train our own model
    - document the journey to custom model training
  - if this setup will be too cumbersome or data heavy, advise with me on best approach
  - advise with me on this step during planning regardless
